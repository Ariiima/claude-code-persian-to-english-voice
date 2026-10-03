import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { needsModel, newTerms, parseJev, plan, preclean, rewriteChangedMeaning } from './register'
import type { Answers } from './register'

type Said = { fa: string; en: string }
type Jev = { before?: Answers; after?: Answers }

// "before" answers for a clean, safe request to the agent: every flaw low
const CLEAN = { has_noise: 0.02, has_vague_reference: 0.03, chat_resolves_reference: 0.02, is_rambling: 0.03, mistranslated: 0.05, is_for_agent: 0.97, is_irreversible: 0.02, mode: 'prompt' }

// Mocks stream.py, the prompt box, the store and the model. `said` is what stream.py hears.
function setup(
  $: Engine,
  on: On,
  opts: { said: Said; box?: string; prefs?: object; reply?: string | null; files?: Record<string, string>; jev?: Jev },
) {
  const clock = mock.clock(on)
  let stop = () => {}
  const stopped = new Promise<void>(resolve => (stop = resolve))
  const out = {
    box: opts.box ?? '',
    submitted: '',
    modelCalls: 0,
    spawned: 0,
    killed: false,
    files: { ...opts.files } as Record<string, string>,
    jevCalls: [] as string[],
    toasts: [] as string[],
  }
  if (opts.jev) {
    // JEV over curl: answers each question set with opts.jev; jev.json lists only those questions
    const jev = opts.jev
    const names = (a?: Answers) => Object.fromEntries(Object.keys(a ?? {}).map(k => [k, {}]))
    out.files['/plugin/hooks/jev.json'] = JSON.stringify({ before: names(jev.before), after: names(jev.after) })
    on('process.run', async (_$, e) => {
      const body = JSON.parse(e.init?.stdin ?? '{}')
      const set = 'rewritten' in (body.state ?? {}) ? 'after' : 'before'
      out.jevCalls.push(set)
      const answers = Object.fromEntries(
        Object.entries(jev[set] ?? {}).map(([k, v]) => [k, typeof v === 'string' ? { type: 'choice', choice: v } : { type: 'noul', noul: v }]),
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
  on('fs.read', async (_$, e) => ({ value: out.files[e.path.replace(/^.*(?=\/hooks\/jev\.json$)/, '/plugin')] ?? '' }))
  on('prompt.read', async () => ({ value: { text: out.box, cursor: out.box.length } }))
  on('prompt.fill', async (_$, e) => {
    out.box = e.mode === 'insert' ? out.box + e.text : e.text
    return { isFilled: true }
  })
  on('prompt.submit', async (_$, e) => {
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
  on('store.get', async (_$, e) => ({ value: e.key === 'prefs' ? opts.prefs : undefined }))
  on('model.complete', async () => {
    out.modelCalls++
    return opts.reply === null
      ? { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: {} as never } }
      : { value: { isAnswered: true as const, text: opts.reply ?? 'POLISHED', usage: {} as never } }
  })
  on('process.spawn', async function* () {
    out.spawned++
    try {
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ fa: opts.said.fa, en: '', lvl: 0.7 })}\n` }
      await stopped
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ ...opts.said, done: true })}\n` }
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
  expect(plan('prompt', 'Run the tests', clean)).toEqual({ drop: false, hold: false, mode: null })
  expect(plan('prompt', 'x', { ...clean, has_noise: 0.95 })).toEqual({ drop: false, hold: false, mode: 'prompt' })
  expect(plan('prompt', 'x', { ...clean, mistranslated: 0.97 }).mode).toBe('prompt')
  expect(plan('prompt', 'x', { ...clean, chat_resolves_reference: 0.97 }).mode).toBe('chat') // "fix that bug": the chat fork names it
  expect(plan('prompt', 'x', { ...clean, has_vague_reference: 0.9 }).mode).toBe('chat')
  expect(plan('spec', 'x', clean).mode).toBe('spec') // spec and commit always reshape
  expect(plan('exact', 'x', { ...clean, has_noise: 0.95 }).mode).toBe(null)
  expect(plan('auto', 'x', { ...clean, mode: 'commit' }).mode).toBe('commit')
  expect(plan('auto', 'x', clean).mode).toBe(null) // auto -> prompt, and the prompt is clean
  expect(plan('prompt', 'x', { ...clean, is_for_agent: 0.1 }).drop).toBe(true)
  expect(plan('prompt', 'x', { ...clean, is_for_agent: 0.3 }).drop).toBe(false) // only drop when JEV is sure
  expect(plan('prompt', 'x', { ...clean, is_irreversible: 0.35 }).hold).toBe(true)
  // no answers (no key, slow, error): the old rules
  expect(plan('prompt', 'Run the tests', null)).toEqual({ drop: false, hold: false, mode: null })
  expect(plan('auto', 'fix the test, no sorry, the login test', null).mode).toBe('prompt')
  expect(plan('commit', 'x', null).mode).toBe('commit')
})

test('JEV: a rewrite that adds, changes or drops something is not used', () => {
  const fine = { adds_request: 0.05, changes_fact: 0.1, drops_fact: 0.2 }
  expect(rewriteChangedMeaning(fine)).toBe(false)
  expect(rewriteChangedMeaning({ ...fine, adds_request: 0.95 })).toBe(true)
  expect(rewriteChangedMeaning({ ...fine, changes_fact: 0.94 })).toBe(true)
  expect(rewriteChangedMeaning({ ...fine, drops_fact: 0.96 })).toBe(true)
  expect(rewriteChangedMeaning(null)).toBe(false) // no answer: keep the rewrite
})

test('learning: technical words added while editing the dictated text', () => {
  expect(newTerms('Fix the parse order function', 'Fix the parseOrder function in auth.ts')).toEqual(['parseOrder', 'auth.ts'])
  expect(newTerms('Fix the test', 'Something totally different with fooBar')).toEqual([]) // not an edit
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
  on('store.set', async () => ({ value: undefined }))
  expect((await fa($, 'key ctrl+x v')).text).toContain('ctrl+x v')
  const kb = JSON.parse(t.out.files[KB] ?? '{}')
  expect(kb.bindings[0].bindings).toEqual({ 'ctrl+e': 'chat:externalEditor' }) // the old binding of the action is gone
  expect(kb.bindings[1]).toEqual({ context: 'Global', bindings: { 'ctrl+x v': 'app:toggleDiffPreSession' } })
  expect((await fa($, 'key v')).text).toContain('cannot be a shortcut') // a bare key would type
})

test('/fa space off: holding Space only types', async ($, on) => {
  const t = setup($, on, { said: { fa: '', en: 'x' } })
  on('store.set', async () => ({ value: undefined }))
  await fa($, 'space off')
  await t.hold()
  expect(t.out.spawned).toBe(0)
  expect(t.out.box).toBe('    ')
})

test('the shortcut button: press to start, press again to stop', async ($, on) => {
  const t = setup($, on, { said: { fa: '...', en: 'run the tests' } })
  on('store.set', async () => ({ value: undefined }))
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
    setup($, on, { said: { fa: '', en: '' } })
    let saved: Record<string, unknown> = {}
    on('store.set', async (_$, e) => {
      saved = e.value as Record<string, unknown>
      return { value: undefined }
    })
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
    expect(saved.mode).toBe('chat')
    expect(await ui.find({ text: /also reads this conversation/ })).toBeDefined() // the mode's explanation
    await ui.press({ key: 'space' })
    expect(saved.holdSpace).toBe(false)
    await ui.select({ key: 'mic', value: '1' })
    expect(saved.mic).toBe('1')
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
test('JEV flow: speech that is not for the agent is ignored', async ($, on) => {
  const t = setup($, on, { said: { fa: '...', en: 'yes mom, I am coming to dinner now' }, jev: { before: { ...CLEAN, is_for_agent: 0.02 } } })
  await t.hold()
  await t.release()
  expect(t.out.box).toBe('')
  expect(t.out.modelCalls).toBe(0)
  expect(t.out.toasts.some(s => s.includes('Not a request'))).toBe(true)
})
test('JEV flow: a rewrite that changes the meaning is replaced by the plain text', async ($, on) => {
  const t = setup($, on, {
    said: { fa: '...', en: 'um fix the login test' },
    reply: 'Fix the login test and add tests for the logout flow.',
    jev: { before: { ...CLEAN, has_noise: 0.95 }, after: { adds_request: 0.97, changes_fact: 0.05, drops_fact: 0.05 } },
  })
  await t.hold()
  await t.release()
  expect(t.out.jevCalls).toEqual(['before', 'after'])
  expect(t.out.modelCalls).toBe(1)
  expect(t.out.box).toBe('Fix the login test')
})
test('JEV flow: a faithful rewrite is used', async ($, on) => {
  const t = setup($, on, {
    said: { fa: '...', en: 'um fix the login test' },
    reply: 'Fix the login test.',
    jev: { before: { ...CLEAN, has_noise: 0.95 }, after: { adds_request: 0.02, changes_fact: 0.05, drops_fact: 0.1 } },
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
test('JEV flow: Auto mode rewrites with the mode JEV picks', async ($, on) => {
  const t = setup($, on, {
    said: { fa: '...', en: 'commit message fixed the null bug in parse order' },
    prefs: { mode: 'auto', autoSend: false, mic: '1' },
    reply: 'Fix null bug in parseOrder',
    jev: { before: { ...CLEAN, mode: 'commit' }, after: { adds_request: 0.02, changes_fact: 0.05, drops_fact: 0.1 } },
  })
  await t.hold()
  await t.release()
  expect(t.out.modelCalls).toBe(1) // commit always reshapes, though the text has no flaw
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
