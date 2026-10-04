import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { JEV_QUESTIONS } from './jev'
import { PROMPTS } from './prompts'
import { KIND_NAMES, needsModel, newTerms, parseJev, plan, preclean, rewriteProblems, systemPrompt, userPrompt } from './register'
import type { Answers } from './register'

type Said = { fa: string; en: string }
// `after` as a list: one answer per "after" call, in order (the last one repeats).
type Jev = { before?: Answers; after?: Answers | Answers[] }

// "before" answers for a clean, safe request to the agent: every flaw low
const CLEAN = { has_noise: 0.02, has_vague_reference: 0.03, chat_resolves_reference: 0.02, is_rambling: 0.03, mistranslated: 0.05, is_for_agent: 0.97, is_irreversible: 0.02, kind: 'general' }
const FAITHFUL = { adds_request: 0.02, changes_fact: 0.05, drops_fact: 0.1 }

// The i-th of a list (the last one past its end), or the value itself.
const nth = <T,>(v: T | T[] | undefined, i: number) => (Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v)

// Mocks stream.py, the prompt box, the store and the model. `said` is what stream.py hears.
// incomplete: stream.py ends without its final "done" line (killed before Soniox finished).
// submitDrop: a hook drops the auto-sent prompt.
function setup(
  $: Engine,
  on: On,
  opts: {
    said: Said
    box?: string
    prefs?: object
    reply?: string | null | string[] // a list: one reply per model call, in order (the last one repeats)
    files?: Record<string, string>
    jev?: Jev
    incomplete?: boolean
    submitDrop?: boolean
    modelGate?: Promise<void> // the rewrite answers only once this resolves
  },
) {
  const clock = mock.clock(on)
  // One stop signal per stream.py run, as each real run waits for its own stop file.
  let stop = () => {}
  const nextStop = () => new Promise<void>(resolve => (stop = resolve))
  const out = {
    box: opts.box ?? '',
    submitted: '',
    modelCalls: 0,
    spawned: 0,
    killed: false,
    files: { ...opts.files } as Record<string, string>,
    jevCalls: [] as string[],
    toasts: [] as string[],
    systems: [] as string[], // the system prompt of each model call
    prompts: [] as string[], // the user message of each model call
    store: {} as Record<string, unknown>,
  }
  if (opts.jev) {
    // JEV over curl: answers each question set with opts.jev (a set it leaves out gets no usable answer)
    const jev = opts.jev
    on('process.run', async (_$, e) => {
      const body = JSON.parse(e.init?.stdin ?? '{}')
      const set = 'rewritten' in (body.state ?? {}) ? 'after' : 'before'
      out.jevCalls.push(set)
      const answers = Object.fromEntries(
        Object.entries(nth(jev[set], out.jevCalls.filter(s => s === set).length - 1) ?? {}).map(([k, v]) => [k, typeof v === 'string' ? { type: 'choice', choice: v } : { type: 'noul', noul: v }]),
      )
      const stdout = e.argv[0] === 'sh' ? JSON.stringify({ answers }) : ''
      return { value: { exitCode: stdout ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
  }
  on('fs.write', async (_$, e) => {
    if (e.path.endsWith('.stop')) stop()
    else out.files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.read', async (_$, e) => ({ value: out.files[e.path] ?? '' }))
  on('prompt.read', async () => ({ value: { text: out.box, cursor: out.box.length } }))
  on('prompt.fill', async (_$, e) => {
    out.box = e.mode === 'insert' ? out.box + e.text : e.text
    return { isFilled: true }
  })
  on('prompt.submit', async (_$, e) => {
    if (opts.submitDrop) return { drop: 'a hook dropped it' }
    out.submitted = e.text
    return { text: e.text, origin: e.origin }
  })
  on('prompt.edit', async (_$, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start + e.inputText.length,
  }))
  on('ui.toast', (_$, e) => {
    out.toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('env.get', async () => ({ value: '/home/test' }))
  on('settings.read', async () => ({ value: {} }))
  on('store.get', async (_$, e) => ({ value: e.key === 'prefs' ? opts.prefs : out.store[e.key] }))
  on('store.set', async (_$, e) => {
    out.store[e.key] = e.value
    return { value: undefined }
  })
  on('model.complete', async (_$, e) => {
    out.modelCalls++
    out.systems.push(e.system ?? '')
    out.prompts.push(e.prompt ?? '')
    await opts.modelGate
    return opts.reply === null
      ? { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: {} as never } }
      : { value: { isAnswered: true as const, text: nth(opts.reply, out.modelCalls - 1) ?? 'POLISHED', usage: {} as never } }
  })
  on('process.spawn', async function* () {
    out.spawned++
    const stopped = nextStop()
    try {
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ fa: opts.said.fa, en: '', lvl: 0.7 })}\n` }
      await stopped
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ ...opts.said, done: !opts.incomplete })}\n` }
      return { value: { code: 0, signal: null } }
    } finally {
      out.killed = true
    }
  })
  // ponytail: the kit's Engine type omits prompt.edit, but the engine raises it
  const prompt = $.prompt as unknown as { edit: (e: unknown) => Promise<{ text: string }> }
  const key = async (k: string) => {
    const r = await prompt.edit({ origin: { kind: 'composer' }, key: { key: k }, text: out.box, cursor: out.box.length, start: out.box.length, end: out.box.length, inputText: k })
    out.box = r.text
  }
  const hold = async () => {
    for (let i = 0; i < 4; i++) {
      await key(' ')
      await clock.advance(50)
    }
  }
  const release = async () => {
    for (let i = 0; i < 12; i++) await clock.advance(100)
  }
  return { out, clock, key, hold, release }
}

const ABOVE = { hasSurvey: false, isWorking: false, maxRows: 10 } as never

test('rules: fillers and stutters go, short requests skip the model', () => {
  expect(preclean('um fix the the test')).toBe('Fix the test')
  expect(preclean('uh, run the tests')).toBe('Run the tests')
  expect(needsModel('prompt', 'Run the tests')).toBe(false)
  expect(needsModel('prompt', 'fix the test, no sorry, the login test')).toBe(true)
  expect(needsModel('spec', 'Run the tests')).toBe(true)
  expect(needsModel('exact', 'a long request with many many words in it here')).toBe(false)
})

test('JEV: reads nouls and choices; a missing or mistyped answer is no answer', () => {
  const res = (answers: object) => JSON.stringify({ answers })
  const ok = res({ has_noise: { type: 'noul', noul: 0.9 }, mode: { type: 'choice', choice: 'spec', confidence: 0.8 } })
  expect(parseJev(ok, ['has_noise', 'mode'])).toEqual({ has_noise: 0.9, mode: 'spec' })
  expect(parseJev(ok, ['has_noise', 'is_rambling'])).toBe(null)
  expect(parseJev(res({ has_noise: { type: 'noul', noul: 'x' } }), ['has_noise'])).toBe(null)
  expect(parseJev('{"error":"bad key"}', ['has_noise'])).toBe(null)
  expect(parseJev('not json', ['has_noise'])).toBe(null)
})

test('JEV: the plan from the answers', () => {
  const clean = CLEAN
  const noisy = { ...clean, has_noise: 0.95 }
  expect(plan('prompt', 'Run the tests', clean)).toEqual({ aside: false, hold: false, kind: null, useChat: false })
  expect(plan('prompt', 'x', noisy)).toEqual({ aside: false, hold: false, kind: 'general', useChat: false })
  expect(plan('prompt', 'x', { ...noisy, kind: 'bug' }).kind).toBe('bug') // JEV picks the prompt
  expect(plan('prompt', 'x', { ...clean, kind: 'bug' }).kind).toBe(null) // a clean bug report stays as it is
  expect(plan('prompt', 'x', { ...clean, kind: 'story' }).kind).toBe('story') // the story editor always reshapes
  expect(plan('prompt', 'x', { ...clean, mistranslated: 0.97 }).kind).toBe('general')
  expect(plan('prompt', 'x', { ...clean, chat_resolves_reference: 0.97 }).useChat).toBe(true) // "fix that bug": the fork names it
  expect(plan('prompt', 'x', { ...clean, has_vague_reference: 0.9 }).useChat).toBe(true)
  expect(plan('chat', 'x', noisy).useChat).toBe(true)
  expect(plan('spec', 'x', { ...clean, kind: 'bug' }).kind).toBe('spec') // spec and commit set by hand win
  expect(plan('exact', 'x', noisy).kind).toBe(null)
  expect(plan('auto', 'x', { ...clean, kind: 'commit' }).kind).toBe('commit')
  expect(plan('prompt', 'x', { ...clean, kind: 'commit' }).kind).toBe(null) // Prompt leaves commit messages to the person
  expect(plan('prompt', 'x', { ...noisy, kind: 'commit' }).kind).toBe('general')
  expect(plan('prompt', 'x', { ...noisy, kind: 'nonsense' }).kind).toBe('general')
  expect(plan('prompt', 'x', { ...noisy, is_for_agent: 0.1 })).toEqual({ aside: true, hold: false, kind: null, useChat: false })
  expect(plan('prompt', 'x', { ...clean, is_for_agent: 0.3 }).aside).toBe(false) // aside only when JEV is sure
  expect(plan('prompt', 'x', { ...clean, is_irreversible: 0.35 }).hold).toBe(true)
  expect(plan('prompt', 'x', clean, false).kind).toBe('general') // an incomplete translation: the rewrite reads the Persian
  expect(plan('exact', 'x', clean, false).kind).toBe(null)
  // no answers (no key, slow, error): the old rules
  expect(plan('prompt', 'Run the tests', null)).toEqual({ aside: false, hold: false, kind: null, useChat: false })
  expect(plan('auto', 'fix the test, no sorry, the login test', null).kind).toBe('general')
  expect(plan('commit', 'x', null).kind).toBe('commit')
  expect(plan('chat', 'x', null)).toEqual({ aside: false, hold: false, kind: 'general', useChat: true })
})

test('prompts: every kind has a rewrite prompt and a JEV option, and nothing else', () => {
  expect(Object.keys(PROMPTS.kinds).sort()).toEqual([...KIND_NAMES].sort())
  expect(Object.keys(JEV_QUESTIONS.before.kind.criteria).sort()).toEqual([...KIND_NAMES].sort())
  const bug = systemPrompt('bug')
  expect(bug).toContain('You turn a speaker') // the shared rules
  expect(bug).toContain(`<task>\n${PROMPTS.kinds.bug}\n</task>`)
})

test('JEV: a rewrite that adds, changes or drops something is not used', () => {
  const fine = { adds_request: 0.05, changes_fact: 0.1, drops_fact: 0.2 }
  expect(rewriteProblems(fine)).toEqual([])
  expect(rewriteProblems({ ...fine, adds_request: 0.95 })).toEqual(['adds_request'])
  expect(rewriteProblems({ ...fine, changes_fact: 0.94, drops_fact: 0.96 })).toEqual(['changes_fact', 'drops_fact'])
  expect(rewriteProblems(null)).toEqual([]) // no answer: keep the rewrite
  // the retry tells Claude its previous rewrite and each problem in it
  const retry = userPrompt('سلام', 'hello', { previous: 'Hello and more.', problems: ['adds_request'] })
  expect(retry).toContain('<previous_rewrite>\nHello and more.\n</previous_rewrite>')
  expect(retry).toContain(`- ${PROMPTS.retry.adds_request}`)
  expect(retry).not.toContain(PROMPTS.retry.drops_fact)
  expect(userPrompt('سلام', 'hello')).toBe('<spoken>\nسلام\n</spoken>\n<draft>\nhello\n</draft>\nRewrite the draft now.')
})

test('learning: technical words added while editing the dictated text', () => {
  expect(newTerms('Fix the parse order function', 'Fix the parseOrder function in auth.ts')).toEqual(['parseOrder', 'auth.ts'])
  expect(newTerms('Fix the test', 'Something totally different with fooBar')).toEqual([]) // not an edit
  expect(newTerms('Use the STE rules here', 'Use the STE rules here and C3')).toEqual([]) // an addition, not a correction
  expect(newTerms('Use the see three module', 'Use the STE module')).toEqual([]) // an acronym is not learned
  expect(newTerms('Use the see three module', 'Use the C3 module')).toEqual(['C3'])
})

test('hold space mid-text: stray space removed, short request filled without the model', async ($, on) => {
  const t = setup($, on, { said: { fa: 'سلام', en: 'um hello there' }, box: 'fix' })
  await t.key(' ')
  expect(t.out.box).toBe('fix ') // a single space types as usual
  await t.clock.advance(400) // the OS key-repeat delay
  await t.key(' ')
  expect(t.out.box).toBe('fix') // the repeat: a hold, its first space removed
  await t.hold()
  await t.release()
  expect(t.out.box).toBe('fix Hello there')
  expect(t.out.modelCalls).toBe(0)
})

const tap = async (t: { key: (k: string) => Promise<void>; clock: { advance: (ms: number) => Promise<unknown> } }) => {
  await t.key(' ')
  await t.clock.advance(200) // a person's tap, not a key repeat
}

test('taps: Space 3 times records without holding; one more tap finishes', async ($, on) => {
  const t = setup($, on, { said: { fa: 'سلام', en: 'run the tests' } })
  for (let i = 0; i < 3; i++) await tap(t)
  await t.clock.advance(3000) // no key held, and still recording
  const ui = await $.ui.mount({ plugin: 'persian-voice', surface: 'terminal', component: 'AbovePrompt', props: ABOVE })
  expect(await ui.find({ text: /tap space to finish/ })).toBeDefined()
  expect(t.out.box).toBe('')
  expect(chordOf(t.out.files)).toBeUndefined() // taps do not repeat, so no chord is needed
  await t.key(' ')
  for (let i = 0; i < 12; i++) await t.clock.advance(100)
  expect(t.out.box).toBe('Run the tests')
})
test('taps: in text, the tapped spaces are removed and the text goes after it', async ($, on) => {
  const t = setup($, on, { said: { fa: 'سلام', en: 'run the tests' }, box: 'fix' })
  for (let i = 0; i < 3; i++) await tap(t)
  await t.clock.advance(3000)
  expect(t.out.box).toBe('fix')
  await t.key(' ')
  for (let i = 0; i < 12; i++) await t.clock.advance(100)
  expect(t.out.box).toBe('fix Run the tests')
})
test('cancel: a letter during a Space recording discards it; the letter does not type; /fa last keeps the words', async ($, on) => {
  const t = setup($, on, { said: { fa: 'سلام', en: 'run the tests' } })
  for (let i = 0; i < 3; i++) await tap(t)
  await t.key('x')
  for (let i = 0; i < 30; i++) await t.clock.advance(100)
  expect(t.out.box).toBe('')
  expect(t.out.killed).toBe(true) // stream.py stopped
  expect(t.out.toasts.some(s => s.includes('Cancelled'))).toBe(true)
  expect((t.out.store.lastDictation as { fa: string }).fa).toBe('سلام')
})
test('cancel: the Cancel button while Claude rewrites, with auto-send on: nothing goes in, nothing is sent', async ($, on) => {
  let answer = () => {}
  const t = setup($, on, {
    said: { fa: '...', en: 'um fix the the test, no sorry, the login test' },
    prefs: { mode: 'prompt', autoSend: true, mic: '1' },
    reply: 'Fix the login test.',
    modelGate: new Promise<void>(resolve => (answer = resolve)),
  })
  await t.hold()
  for (let i = 0; i < 12; i++) await t.clock.advance(100) // released; the rewrite runs
  expect(t.out.modelCalls).toBe(1)
  const ui = await $.ui.mount({ plugin: 'persian-voice', surface: 'terminal', component: 'AbovePrompt', props: ABOVE })
  await ui.press({ key: 'cancel' })
  answer() // the rewrite ends after the cancel
  for (let i = 0; i < 10; i++) await t.clock.advance(100)
  expect(t.out.submitted).toBe('')
  expect(t.out.box).toBe('')
})
test('cancel: a new recording can start at once after a cancel', async ($, on) => {
  const t = setup($, on, { said: { fa: 'سلام', en: 'run the tests' } })
  for (let i = 0; i < 3; i++) await tap(t)
  await t.key('x') // cancel
  for (let i = 0; i < 3; i++) await tap(t) // start again right away
  await t.clock.advance(1000)
  await t.key(' ') // finish
  for (let i = 0; i < 20; i++) await t.clock.advance(100)
  expect(t.out.box).toBe('Run the tests')
  expect(t.out.spawned).toBe(2)
})
test('a single Space at an empty prompt, then nothing: cancelled, so background noise is not filled in', async ($, on) => {
  const t = setup($, on, { said: { fa: 'سلام', en: 'some noise' } })
  await t.key(' ')
  for (let i = 0; i < 30; i++) await t.clock.advance(100)
  expect(t.out.box).toBe('')
})
test('taps: two taps at an empty prompt start nothing', async ($, on) => {
  const t = setup($, on, { said: { fa: 'سلام', en: 'run the tests' } })
  await tap(t)
  await tap(t)
  for (let i = 0; i < 30; i++) await t.clock.advance(100)
  const ui = await $.ui.mount({ plugin: 'persian-voice', surface: 'terminal', component: 'AbovePrompt', props: ABOVE })
  expect(await ui.find({ text: /Hold space to talk/ })).toBeDefined() // the idle band: no recording
  expect(t.out.box).toBe('')
})

const chordOf = (files: Record<string, string>) =>
  (JSON.parse(files[KB] ?? '{}').bindings ?? []).find((b: { context: string }) => b.context === 'Chat')?.bindings['space space']

test('cursor: a held Space binds the `space space` chord while it records, and only then', async ($, on) => {
  const mine = { bindings: [{ context: 'Global', bindings: { 'ctrl+e': 'chat:externalEditor' } }] }
  const t = setup($, on, { said: { fa: '...', en: 'run the tests' }, files: { [KB]: JSON.stringify(mine) } })
  await t.hold()
  expect(chordOf(t.out.files)).toBe('app:toggleDiffPreSession') // Claude Code takes the held Space
  await t.release()
  expect(t.out.box).toBe('Run the tests')
  expect(chordOf(t.out.files)).toBeUndefined() // released: Space types again
  expect(JSON.parse(t.out.files[KB] ?? '{}').bindings[0]).toEqual(mine.bindings[0]) // the person's bindings stay
})
test('cursor: the chord\'s button presses keep the recording alive, and it ends when they stop', async ($, on) => {
  const t = setup($, on, { said: { fa: '...', en: 'run the tests' } })
  await t.hold()
  const ui = await $.ui.mount({ plugin: 'persian-voice', surface: 'terminal', component: 'AbovePrompt', props: ABOVE })
  for (let i = 0; i < 20; i++) {
    // Space now reaches the plugin only as the chord's presses of its button, not as typed spaces
    await ui.press({ key: 'hold' })
    await t.clock.advance(70)
  }
  expect(t.out.box).toBe('') // 1.4 s without a typed space, and still recording
  await t.release()
  expect(t.out.box).toBe('Run the tests')
})
test('cursor: a chord left on by a crash is removed when the session starts', async ($, on) => {
  const stale = { bindings: [{ context: 'Chat', bindings: { 'space space': 'app:toggleDiffPreSession', 'ctrl+e': 'chat:externalEditor' } }] }
  const t = setup($, on, { said: { fa: '', en: '' }, files: { [KB]: JSON.stringify(stale) } })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async () => ({ cwd: '/tmp' }) as never) // the engine's own answer, beneath the plugin
  await ($.session as unknown as { start: (e: unknown) => Promise<unknown> }).start({ cwd: '/tmp' }) // the reload after the crash
  expect(chordOf(t.out.files)).toBeUndefined()
  expect(JSON.parse(t.out.files[KB] ?? '{}').bindings[0].bindings['ctrl+e']).toBe('chat:externalEditor')
})

test('polish: a self-corrected request goes through the model; Use plain translation swaps it back', async ($, on) => {
  const t = setup($, on, { said: { fa: '...', en: 'um fix the the test, no sorry, the login test' }, reply: 'Fix the login test.' })
  await t.hold()
  await t.release()
  expect(t.out.modelCalls).toBe(1)
  expect(t.out.box).toBe('Fix the login test.')
  const ui = await $.ui.mount({ plugin: 'persian-voice', surface: 'terminal', component: 'AbovePrompt', props: ABOVE })
  await ui.press({ key: 'undo' })
  expect(t.out.box).toBe('Fix the test, no sorry, the login test')
})

test('polish: the model fails, so the rule-cleaned text is filled', async ($, on) => {
  const t = setup($, on, { said: { fa: '...', en: 'um fix the the test, no sorry, the login test' }, reply: null })
  await t.hold()
  await t.release()
  expect(t.out.box).toBe('Fix the test, no sorry, the login test')
})

test('a single leading space then typing: the tentative recording is cancelled, nothing filled', async ($, on) => {
  const t = setup($, on, { said: { fa: 'x', en: 'should not appear' } })
  await t.key(' ')
  await t.clock.advance(10)
  expect(t.out.spawned).toBe(1) // started at once, to keep the first words
  await t.key('a')
  await t.release()
  expect(t.out.killed).toBe(true)
  expect(t.out.box).toBe('a')
})

const KB = '/home/test/.claude/keybindings.json'
const fa = ($: Engine, args: string) =>
  $.command.run({ command: 'fa', args, origin: { kind: 'composer' }, presentation: {} } as never) as Promise<{ text: string }>

test('/fa key writes the shortcut to keybindings.json and keeps the other bindings', async ($, on) => {
  const old = { bindings: [{ context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor', f2: 'app:toggleDiffPreSession' } }] }
  const t = setup($, on, { said: { fa: '', en: '' }, files: { [KB]: JSON.stringify(old) } })
  expect((await fa($, 'key ctrl+x v')).text).toContain('ctrl+x v')
  const kb = JSON.parse(t.out.files[KB] ?? '{}')
  expect(kb.bindings[0].bindings).toEqual({ 'ctrl+e': 'chat:externalEditor' }) // the old binding of the action is gone
  expect(kb.bindings[1]).toEqual({ context: 'Global', bindings: { 'ctrl+x v': 'app:toggleDiffPreSession' } })
  expect((await fa($, 'key v')).text).toContain('cannot be a shortcut') // a bare key would type
})

test('/fa space off: holding Space only types', async ($, on) => {
  const t = setup($, on, { said: { fa: '', en: 'x' } })
  await fa($, 'space off')
  await t.hold()
  expect(t.out.spawned).toBe(0)
  expect(t.out.box).toBe('    ')
})

test('the shortcut button: press to start, press again to stop', async ($, on) => {
  const t = setup($, on, { said: { fa: '...', en: 'run the tests' } })
  await fa($, 'key ctrl+x v')
  const ui = await $.ui.mount({ plugin: 'persian-voice', surface: 'terminal', component: 'AbovePrompt', props: ABOVE })
  await ui.press({ key: 'talk' })
  await t.clock.advance(2000)
  expect(t.out.spawned).toBe(1)
  await ui.press({ key: 'stop' })
  await t.release()
  expect(t.out.box).toBe('Run the tests')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/fa opens the settings dialog on ${surface}; its controls change the settings`, async ($, on) => {
    const t = setup($, on, { said: { fa: '', en: '' } })
    const saved = () => t.out.store.prefs as Record<string, unknown>
    on('process.run', async () => ({
      value: {
        exitCode: 1,
        stdout: '',
        stderr: 'AVFoundation audio devices:\n[x] [1] MacBook Pro Microphone\n',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    let opened = ''
    on('ui.open', async (_$, e) => {
      opened = e.id
      return { value: { isPlaced: true } }
    })
    expect((await fa($, '')).text).toContain('settings')
    expect(opened).toBe('fa-settings')
    const ui = await $.ui.mount({
      plugin: 'persian-voice',
      surface,
      component: 'Pane',
      requestId: 'fa-settings',
      props: { title: 'Persian Voice · settings', isFocused: true, bodyColumns: 100, placement: 'inline' } as never,
    })
    expect(await ui.find({ text: /reads this chat|Claude rewrites/ })).toBeDefined()
    await ui.select({ key: 'mode', value: 'chat' })
    expect(saved().mode).toBe('chat')
    expect(await ui.find({ text: /always reads this conversation/ })).toBeDefined() // the mode's explanation
    await ui.press({ key: 'space' })
    expect(saved().holdSpace).toBe(false)
    await ui.select({ key: 'mic', value: '1' })
    expect(saved().mic).toBe('1')
  })
}

test('/fa rec starts and stops a recording without holding a key', async ($, on) => {
  const t = setup($, on, { said: { fa: '...', en: 'run the tests' } })
  expect((await fa($, 'rec')).text).toContain('Listening')
  await t.clock.advance(2000)
  expect((await fa($, 'rec')).text).toContain('Stopping')
  await t.release()
  expect(t.out.box).toBe('Run the tests')
})

test('JEV flow: a clean long request skips the model that the old rule would call', async ($, on) => {
  const en = 'rename the function getUser to fetchUser in src api users and update all callers'
  const t = setup($, on, { said: { fa: '...', en }, jev: { before: CLEAN } })
  await t.hold()
  await t.release()
  expect(needsModel('prompt', en)).toBe(true)
  expect(t.out.jevCalls).toEqual(['before'])
  expect(t.out.modelCalls).toBe(0)
  expect(t.out.box).toBe(preclean(en))
})
test('JEV flow: speech that is not for the assistant stays in the box, not sent and not rewritten', async ($, on) => {
  const t = setup($, on, {
    said: { fa: '...', en: 'um yes mom, I am coming to dinner now' },
    prefs: { mode: 'prompt', autoSend: true, mic: '1' },
    jev: { before: { ...CLEAN, has_noise: 0.9, is_for_agent: 0.02 } },
  })
  await t.hold()
  await t.release()
  expect(t.out.box).toBe('Yes mom, I am coming to dinner now')
  expect(t.out.submitted).toBe('')
  expect(t.out.modelCalls).toBe(0)
  expect(t.out.toasts.some(s => s.includes('does not look like a request'))).toBe(true)
})
test('lost text: a long recording whose translation did not finish gets Claude\'s translation', async ($, on) => {
  const t = setup($, on, { said: { fa: 'فصل سوم داستانم رو بخون', en: '' }, reply: 'Read the third chapter of my story.' })
  await t.hold()
  await t.release()
  expect(t.out.box).toBe('Read the third chapter of my story.')
  expect(t.out.store.lastDictation).toEqual({ fa: 'فصل سوم داستانم رو بخون', en: '' })
})
test('lost text: when that translation fails too, the Persian goes in the box', async ($, on) => {
  const t = setup($, on, { said: { fa: 'فصل سوم داستانم رو بخون', en: '' }, reply: null })
  await t.hold()
  await t.release()
  expect(t.out.box).toBe('فصل سوم داستانم رو بخون')
})
test('lost text: a stream stopped before Soniox finished is rewritten from the Persian', async ($, on) => {
  const t = setup($, on, { said: { fa: '...', en: 'run the tests' }, incomplete: true, reply: 'Run the tests and then build the app.' })
  await t.hold()
  await t.release()
  expect(t.out.modelCalls).toBe(1) // the old rule would skip a short request
  expect(t.out.box).toBe('Run the tests and then build the app.')
})
test('lost text: an auto-sent prompt that a hook drops comes back to the box', async ($, on) => {
  const t = setup($, on, { said: { fa: '...', en: 'run the tests' }, prefs: { mode: 'prompt', autoSend: true, mic: '1' }, submitDrop: true })
  await t.hold()
  await t.release()
  await t.clock.advance(10)
  expect(t.out.box).toBe('Run the tests')
  expect(t.out.toasts.some(s => s.includes('not sent'))).toBe(true)
})
test('lost text: /fa last shows the last recording and puts it back', async ($, on) => {
  const t = setup($, on, { said: { fa: 'تست‌ها رو اجرا کن', en: 'run the tests' } })
  expect((await fa($, 'last')).text).toContain('No recording')
  await t.hold()
  await t.release()
  t.out.box = '' // the person sent or cleared it
  const r = await fa($, 'last')
  await t.clock.advance(10)
  expect(r.text).toContain('تست‌ها رو اجرا کن')
  expect(r.text).toContain('run the tests')
  expect(t.out.box).toBe('run the tests')
})
test('kinds: JEV picks the bug-fix prompt for the rewrite', async ($, on) => {
  const t = setup($, on, {
    said: { fa: '...', en: 'um the app crashes when the cart is empty' },
    reply: 'Fix the crash when the cart is empty.',
    jev: { before: { ...CLEAN, has_noise: 0.95, kind: 'bug' }, after: FAITHFUL },
  })
  await t.hold()
  await t.release()
  expect(t.out.systems[0]).toBe(systemPrompt('bug'))
  expect(t.out.box).toBe('Fix the crash when the cart is empty.')
})
test('kinds: a clean story request still gets the story-editor prompt', async ($, on) => {
  const t = setup($, on, {
    said: { fa: '...', en: 'read chapter three and tell me where the pacing slows down' },
    reply: 'Act as an experienced fiction editor. Read chapter three and find where the pacing slows down.',
    jev: { before: { ...CLEAN, kind: 'story' }, after: FAITHFUL },
  })
  await t.hold()
  await t.release()
  expect(t.out.systems[0]).toBe(systemPrompt('story'))
  expect(t.out.box).toContain('Act as an experienced fiction editor.')
})
test('JEV flow: a rewrite that changes the meaning is replaced by the plain text', async ($, on) => {
  const t = setup($, on, {
    said: { fa: '...', en: 'um fix the login test' },
    reply: 'Fix the login test and add tests for the logout flow.',
    jev: { before: { ...CLEAN, has_noise: 0.95 }, after: { adds_request: 0.97, changes_fact: 0.05, drops_fact: 0.05 } },
  })
  await t.hold()
  await t.release()
  expect(t.out.jevCalls).toEqual(['before', 'after', 'after']) // the retry failed its check too
  expect(t.out.modelCalls).toBe(2)
  expect(t.out.box).toBe('Fix the login test')
})
test('JEV flow: a rewrite that fails its check is retried once, told what was wrong', async ($, on) => {
  const t = setup($, on, {
    said: { fa: '...', en: 'um fix the login test' },
    reply: ['Fix the login test and add tests for the logout flow.', 'Fix the login test.'],
    jev: { before: { ...CLEAN, has_noise: 0.95 }, after: [{ adds_request: 0.97, changes_fact: 0.05, drops_fact: 0.05 }, FAITHFUL] },
  })
  await t.hold()
  await t.release()
  expect(t.out.modelCalls).toBe(2)
  expect(t.out.prompts[1]).toContain('<previous_rewrite>\nFix the login test and add tests for the logout flow.\n</previous_rewrite>')
  expect(t.out.prompts[1]).toContain(PROMPTS.retry.adds_request)
  expect(t.out.box).toBe('Fix the login test.')
})
test('JEV flow: a faithful rewrite is used', async ($, on) => {
  const t = setup($, on, {
    said: { fa: '...', en: 'um fix the login test' },
    reply: 'Fix the login test.',
    jev: { before: { ...CLEAN, has_noise: 0.95 }, after: FAITHFUL },
  })
  await t.hold()
  await t.release()
  expect(t.out.box).toBe('Fix the login test.')
})
test('JEV flow: with auto-send, a request that cannot be undone stays in the box', async ($, on) => {
  const t = setup($, on, {
    said: { fa: '...', en: 'drop the users table in production' },
    prefs: { mode: 'prompt', autoSend: true, mic: '1' },
    jev: { before: { ...CLEAN, is_irreversible: 0.95 } },
  })
  await t.hold()
  await t.release()
  expect(t.out.submitted).toBe('')
  expect(t.out.box).toBe('Drop the users table in production')
  expect(t.out.toasts.some(s => s.includes('Not sent'))).toBe(true)
})
test('JEV flow: Auto mode rewrites with the kind JEV picks', async ($, on) => {
  const t = setup($, on, {
    said: { fa: '...', en: 'commit message fixed the null bug in parse order' },
    prefs: { mode: 'auto', autoSend: false, mic: '1' },
    reply: 'Fix null bug in parseOrder',
    jev: { before: { ...CLEAN, kind: 'commit' }, after: FAITHFUL },
  })
  await t.hold()
  await t.release()
  expect(t.out.modelCalls).toBe(1) // commit always reshapes, though the text has no flaw
  expect(t.out.systems[0]).toBe(systemPrompt('commit'))
  expect(t.out.box).toBe('Fix null bug in parseOrder')
})
test('auto-send: the text is sent, not left in the box', async ($, on) => {
  const t = setup($, on, { said: { fa: '...', en: 'run the tests' }, prefs: { mode: 'prompt', autoSend: true, mic: '1' } })
  await t.hold()
  await t.release()
  expect(t.out.submitted).toBe('Run the tests')
  expect(t.out.box).toBe('')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draws idle and listening views on ${surface}`, async ($, on) => {
    const t = setup($, on, { said: { fa: 'سلام دنیا', en: 'hello world' } })
    const ui = await $.ui.mount({ plugin: 'persian-voice', surface, component: 'AbovePrompt', props: ABOVE })
    expect(await ui.find({ key: 'mode' })).toBeDefined()
    await t.hold()
    expect((await ui.find({ text: /REC/ }))).toBeDefined()
    expect((await ui.find({ text: /سلام دنیا/ }))).toBeDefined()
    await t.release()
    expect(await ui.find({ key: 'mode' })).toBeDefined()
  })
}
