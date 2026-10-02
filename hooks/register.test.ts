import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { needsModel, newTerms, preclean } from './register'

type Said = { fa: string; en: string }

// Mocks stream.py, the prompt box, the store and the model. `said` is what stream.py hears.
function setup(
  $: Engine,
  on: On,
  opts: { said: Said; box?: string; prefs?: object; reply?: string | null; files?: Record<string, string> },
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
    out.submitted = e.text
    return { text: e.text, origin: e.origin }
  })
  on('prompt.edit', async (_$, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start + e.inputText.length,
  }))
  on('ui.toast', () => ({ value: undefined }))
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
