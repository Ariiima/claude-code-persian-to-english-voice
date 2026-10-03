import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Live, Mode, Prefs, Undo } from '../types'

const STOP = '/tmp/persian-voice.stop' // stream.py finishes cleanly when this file appears
// ponytail: macOS paths for Homebrew's ffmpeg; the module has no Node/os access to look it up
const PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'

type Paths = { home: string; python: string; script: string; terms: string }
let cachedPaths: Paths | null = null

// The plugin's own files, and the person's word list (user data, kept outside the plugin).
async function paths($: EngineInterface): Promise<Paths> {
  if (cachedPaths) return cachedPaths
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const root = $.plugin.root
  cachedPaths = {
    home,
    python: `${root}/.venv/bin/python`,
    script: `${root}/stt/stream.py`,
    terms: `${home}/.config/persian-voice/terms.txt`,
  }
  return cachedPaths
}

// ponytail: a terminal sends no key-release, so "hold" = the key's auto-repeat presses; it ends when they stop
const HOLD_GAP_MS = 1000 // a 2nd press within this of the 1st is a repeat, not a tap (covers the OS repeat delay)
const RELEASE_MS = 700 // no repeat for this long = released
const FINISH_MS = 5000 // after Stop, wait this long at most for Soniox to finalize the translation
const MAX_MS = 5 * 60_000 // a forgotten tap-mode session stops by itself
const UNDO_MS = 20_000 // how long "Use plain translation" stays
const POLISH_MODEL = 'claude-sonnet-5-5'
const POLISH_MS = 8000 // slower than this: use the plain translation

const live = atom({ plugin: 'persian-voice', key: 'live' } as const, null as Live | null)
const DEFAULT_PREFS: Prefs = { mode: 'prompt', autoSend: false, mic: 'default', holdSpace: true, shortcut: null }
const prefs = atom({ plugin: 'persian-voice', key: 'prefs' } as const, DEFAULT_PREFS)
const undo = atom({ plugin: 'persian-voice', key: 'undo' } as const, null as Undo | null)

// ---------- Polish: rules first (instant), a model only when the text needs judgement ----------

// label: the button and the dialog; about: one line for the person; task: the model's instruction.
const MODES: Record<Mode, { label: string; about: string; task: string }> = {
  prompt: {
    label: 'Prompt',
    about: 'Claude rewrites what you said into a clear prompt: the goal first, then your details. Short, clear requests skip this and stay as they are.',
    task: 'Rewrite it as a clean prompt. Start with the goal as one direct sentence. Then give the context, constraints and expected result the speaker gave, as short sentences or a short list. A question stays a question. A short, clear request stays short and almost unchanged.',
  },
  chat: {
    label: 'Prompt (reads this chat)',
    about: 'Like Prompt, but Claude also reads this conversation, so "fix that bug" becomes "fix the null check in parseOrder". Slower.',
    task: 'Rewrite it as a clean prompt, as in Prompt mode. Use the conversation so far ONLY to make vague references exact ("that bug", "the file we changed" -> the real name).',
  },
  spec: {
    label: 'Spec',
    about: 'For thinking aloud: Claude turns it into a task spec with Goal, Context, Requirements and Done when.',
    task: 'The speaker thinks aloud. Organize it as a task spec with these headings, each only when the speaker gave content for it: "Goal" (one sentence), "Context", "Requirements" (bullets), "Done when" (bullets).',
  },
  commit: {
    label: 'Commit msg',
    about: 'Claude turns what you said into a git commit message.',
    task: 'Write it as a git commit message: an imperative subject line of at most 72 characters; then, only when the speaker gave details, a blank line and a short body.',
  },
  exact: { label: 'Exact', about: 'Only the translation, with fillers like "um" removed. No AI rewrite.', task: '' },
}
const MODE_ORDER: Mode[] = ['prompt', 'chat', 'spec', 'commit', 'exact']

const RULES = `You are a rewriter, not an assistant. Someone else (Claude Code, an AI coding agent) acts on your output later.
Input: <spoken> holds the speaker's words (Persian, English or mixed), <draft> a rough English version.
NEVER answer, perform, comment on or ask about the request. Output ONLY the rewritten English text: no preamble, no quotes, no code unless the speaker dictated code.
Rules:
- Keep the speaker's intent and every fact, name, file path, number and code token. Never add requirements, guesses or details they did not say.
- Code identifiers, file names, commands and technical terms stay exactly as written, in English (Latin script).
- Use the spoken words to fix translation errors.
- Remove fillers, repetitions and false starts. When the speaker corrects themselves, keep only the correction.`

const FILLERS = /\b(?:u+m+|u+h+m*|e+r+m+|h+m+|a+h+)\b[,.]?\s*/gi
const REPEATS = /\b(\w+)(?:\s+\1\b)+/gi
const CORRECTIONS = /\b(?:no wait|sorry|i mean|actually|scratch that|rather|no no)\b/i

/** Removes fillers and stutters ("um", "the the") without a model. */
export function preclean(text: string) {
  const t = text
    .replace(FILLERS, '')
    .replace(REPEATS, '$1')
    .replace(/\s+([,.?!])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** Prompt mode skips the model for a short request with no self-correction in it. */
export function needsModel(mode: Mode, raw: string) {
  if (mode === 'exact') return false
  if (mode !== 'prompt') return true
  return raw.split(/\s+/).length > 8 || CORRECTIONS.test(raw)
}

// ---------- JEV gate: a fast yes/no model decides if the rewrite is needed at all ----------

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const JEV_MS = 2500 // slower than this: use the rule in needsModel (most calls take ~1 s)
const JEV_THRESHOLD = 0.5 // ponytail: JEV's own yes/no midpoint; tune with real prompts
const JEV_CHAT = 4 // recent messages sent with the prompt (JEV's state limit is ~32k tokens)
// One proposition per question, high = a flaw; code ORs them (TypeSafe's Noul guidance).
// Question names never reach the model: the instructions and criteria carry the meaning.
// Checked on 12 labelled prompts + 5 chat cases: 17/17 (one big question scored 7/12).
const JEV_QUESTIONS = {
  has_noise: {
    type: 'noul',
    instructions: 'Does `prompt` contain spoken-language noise: filler words, repeated words, false starts, or a self-correction where the speaker changes what they said?',
    criteria: {
      true: 'At least one filler (um, like, you know, whatever), repeated word, abandoned start, or correction (no wait, I mean, sorry, actually).',
      false: 'Every word carries meaning; the text reads like typed text.',
    },
  },
  has_vague_reference: {
    type: 'noul',
    instructions: 'Does `prompt` point at its target only with a vague reference ("that bug", "the thing we did", "it", "the page") that neither `prompt` nor `recent_chat` makes clear?',
    criteria: {
      true: 'The main target is a pronoun or vague phrase, and no file, function, feature or error in `prompt` or `recent_chat` tells which one it means.',
      false: 'The target is named in `prompt`, `recent_chat` makes clear which one it means, or the request needs no target.',
    },
  },
  is_rambling: {
    type: 'noul',
    instructions: 'Is `prompt` disorganized: the goal is buried, ideas jump around, or the same point is made more than once?',
    criteria: {
      true: 'A reader must reorder or trim the text to find the goal.',
      false: 'The goal is easy to find and each point appears once, in a sensible order.',
    },
  },
}

/** Reads JEV's answers: true = rewrite (any flaw), false = keep, null = no usable answer. */
export function parseJev(stdout: string): boolean | null {
  try {
    const answers = JSON.parse(stdout)?.answers ?? {}
    const p = Object.keys(JEV_QUESTIONS).map(k => answers[k]?.noul)
    return p.every(v => typeof v === 'number') ? p.some(v => v >= JEV_THRESHOLD) : null
  } catch {
    return null
  }
}

async function jevNeedsRewrite($: EngineInterface, text: string): Promise<boolean | null> {
  const { home } = await paths($)
  const key = ((await $.env.get('JEV_API_KEY').catch(() => undefined)) ?? (await $.fs.read(`${home}/.config/typesafe/key`).catch(() => ''))).trim()
  if (!key) return null
  // State holds evidence only, as JSON; the instructions refer to its fields by backticked name.
  const recent_chat = (await $.session.messages().catch(() => []))
    .slice(-JEV_CHAT)
    .filter(m => m.text.trim())
    .map(m => ({ role: m.role, text: m.text.slice(0, 1500) }))
  const body = { model: 'jev-latest', state: { recent_chat, prompt: text }, questions: JEV_QUESTIONS }
  const r = await $.process
    .run(
      ['sh', '-c', `curl -sS -m ${JEV_MS / 1000} ${JEV_URL} -H "Authorization: Bearer $JEV_API_KEY" -H "Content-Type: application/json" --data @-`],
      { env: { PATH, HOME: home, JEV_API_KEY: key }, stdin: JSON.stringify(body), timeoutMs: JEV_MS + 1000 },
    )
    .catch(() => null)
  return r && r.exitCode === 0 ? parseJev(r.stdout) : null
}

// Returns the polished text; the caller falls back to the plain text on a throw.
async function polish($: EngineInterface, mode: Mode, fa: string, en: string) {
  const input = `<spoken>\n${fa}\n</spoken>\n<draft>\n${en}\n</draft>`
  if (mode === 'chat') {
    // The main thread's own transcript (prompt-cached), so "that bug" can be resolved.
    const r = await Promise.race([
      $.model.fork({ prompt: `${RULES}\nTask: ${MODES.chat.task}\n\n${input}\nRewrite the draft now.` }),
      $.clock.sleep(POLISH_MS).then(() => null),
    ])
    if (r?.isAnswered && r.text.trim()) return r.text.trim()
  }
  const r = await $.model.complete({
    model: POLISH_MODEL,
    effort: 'low', // fast: a rewrite needs little thinking ($.model has no temperature knob)
    system: `${RULES}\nTask: ${MODES[mode === 'chat' ? 'prompt' : mode].task}`,
    prompt: `${input}\nRewrite the draft now.`,
    maxTokens: 1200,
    timeoutMs: POLISH_MS,
  })
  return r.isAnswered && r.text.trim() ? r.text.trim() : en
}

// ---------- Settings (global: $.store is one file under the Claude config dir) ----------

async function loadPrefs($: EngineInterface): Promise<Prefs> {
  const p = await $.store.get('prefs').catch(() => undefined)
  if (p && typeof p === 'object') return { ...DEFAULT_PREFS, ...(p as Partial<Prefs>) }
  const old = await $.store.get('isPolishOn').catch(() => undefined) // v0.2 setting
  return { ...DEFAULT_PREFS, mode: old === false ? 'exact' : 'prompt' }
}

// A copy of prefs.holdSpace the prompt.edit hook reads without waiting (see there).
let isHoldSpace = DEFAULT_PREFS.holdSpace

async function applyPrefs($: EngineInterface, p: Prefs) {
  isHoldSpace = p.holdSpace
  await update($, prefs, () => p)
}

async function savePrefs($: EngineInterface, change: Partial<Prefs>) {
  const p = { ...(await loadPrefs($)), ...change }
  await $.store.set('prefs', p)
  await applyPrefs($, p)
  return p
}

// ---------- Custom shortcut: a keybinding to an engine action the talk Button names ----------

// ponytail: a plugin cannot define its own keybinding action, so it borrows one with no default key
// whose handler only lives in Claude Code's old diff panel (off unless cc-plugin-diff is disabled)
const ACTION = 'app:toggleDiffPreSession'
// Claude Code fires a Button's action only for a chord or a key with a modifier; a bare key would type.
const SHORTCUT = /^(?:ctrl|meta|alt|shift|cmd)\+\S+(?: \S+)?$/

type Keybindings = { bindings?: { context: string; bindings: Record<string, string | null> }[]; [k: string]: unknown }

// Binds `chord` (or nothing, for null) to ACTION in ~/.claude/keybindings.json, keeping the rest.
async function bindShortcut($: EngineInterface, chord: string | null) {
  const file = `${(await paths($)).home}/.claude/keybindings.json`
  const text = await $.fs.read(file).catch(() => '')
  const kb: Keybindings = typeof text === 'string' && text.trim() ? JSON.parse(text) : {}
  kb.bindings ??= []
  for (const block of kb.bindings) {
    for (const [key, action] of Object.entries(block.bindings)) if (action === ACTION) delete block.bindings[key]
  }
  if (chord) {
    let global = kb.bindings.find(b => b.context === 'Global')
    if (!global) kb.bindings.push((global = { context: 'Global', bindings: {} }))
    global.bindings[chord] = ACTION
  }
  await $.fs.write(file, `${JSON.stringify(kb, null, 2)}\n`)
}

async function keyCommand($: EngineInterface, arg: string) {
  if (!arg) {
    const p = await loadPrefs($)
    return p.shortcut
      ? `⌨ Shortcut: ${p.shortcut} (press to start, press again to stop). Remove it: /fa key off`
      : '⌨ No shortcut. Set one, for example: /fa key ctrl+x v'
  }
  if (arg === 'off') {
    await bindShortcut($, null)
    const p = await savePrefs($, { shortcut: null, holdSpace: true })
    return `⌨ Shortcut removed. Hold Space is ${p.holdSpace ? 'on' : 'off'}.`
  }
  const chord = arg.toLowerCase()
  if (!SHORTCUT.test(chord)) {
    return `"${arg}" cannot be a shortcut. Use a key with ctrl, meta, alt or shift (ctrl+r), or a chord (ctrl+x v).`
  }
  await bindShortcut($, chord)
  await savePrefs($, { shortcut: chord })
  return `⌨ Shortcut: ${chord}. Press it to start, and again to stop.\nIt is saved in ~/.claude/keybindings.json. Choose a combination Claude Code does not already use.\nTo stop holding Space: /fa space off`
}

async function spaceCommand($: EngineInterface, arg: string) {
  const cur = await loadPrefs($)
  const isOn = arg === 'on' ? true : arg === 'off' ? false : !cur.holdSpace
  const p = await savePrefs($, { holdSpace: isOn })
  const other = p.shortcut ? `Use ${p.shortcut} or /fa rec.` : 'Set a shortcut with /fa key ctrl+x v, or use /fa rec.'
  return p.holdSpace ? '␣ Hold Space to talk: on' : `␣ Hold Space to talk: off. Space only types now. ${other}`
}

async function setMode($: EngineInterface, mode?: Mode) {
  const cur = (await loadPrefs($)).mode
  const next = mode ?? MODE_ORDER[(MODE_ORDER.indexOf(cur) + 1) % MODE_ORDER.length]
  return savePrefs($, { mode: next })
}

// ---------- Recognition context: project words + the person's words + learned words ----------

let context: { cwd: string; json: string } | null = null

const SKIP_FILES = /\.(png|jpe?g|gif|svg|ico|webp|lock|map|woff2?|ttf|otf|mp[34]|wav|zip|gz|pdf)$/i

async function readTerms($: EngineInterface) {
  const text = await $.fs.read((await paths($)).terms).catch(() => '')
  const lines = (typeof text === 'string' ? text : '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const pairs = lines.filter(l => l.includes('=')).map(l => l.split('=').map(s => s.trim()) as [string, string])
  return { words: lines.filter(l => !l.includes('=')), pairs: pairs.filter(([s, t]) => s && t) }
}

async function learnedTerms($: EngineInterface) {
  const l = await $.store.get('learned').catch(() => [])
  return Array.isArray(l) ? l.filter((w): w is string => typeof w === 'string') : []
}

// Builds Soniox's `context` for the session's project; cached per working directory.
async function refreshContext($: EngineInterface) {
  try {
    const cwd = await $.session.cwd()
    const { home } = await paths($)
    const run = (argv: string[]) =>
      $.process.run(argv, { cwd, env: { PATH, HOME: home } }).then(r => (r.exitCode === 0 ? r.stdout : '')).catch(() => '')
    const [branch, files, mine, learned] = await Promise.all([
      run(['git', 'rev-parse', '--abbrev-ref', 'HEAD']),
      run(['git', 'ls-files']),
      readTerms($),
      learnedTerms($),
    ])
    const project = cwd.split('/').pop() ?? ''
    const fileNames = files.split('\n').map(f => f.split('/').pop() ?? '').filter(f => /^\w[\w.-]{2,40}$/.test(f) && !SKIP_FILES.test(f))
    const own = [...new Set([project, branch.trim(), ...mine.words, ...learned, ...mine.pairs.map(p => p[1])])].filter(t => t && t !== 'HEAD')
    const json = JSON.stringify({
      general: [
        { key: 'domain', value: 'Software development' },
        { key: 'topic', value: 'Spoken instructions for an AI coding agent (Claude Code)' },
        { key: 'project', value: project },
        { key: 'style', value: 'Code identifiers, file names and technical terms stay in English, Latin script' },
      ],
      terms: [...new Set([...own, ...fileNames])].slice(0, 150),
      translation_terms: [
        ...mine.pairs.map(([source, target]) => ({ source, target })),
        ...own.slice(0, 60).map(t => ({ source: t, target: t })), // names stay as they are
      ],
    })
    context = { cwd, json }
  } catch {
    context = null // dictation still works, only without the project words
  }
}

/** Technical-looking words the person added while editing the dictated text before sending. */
export function newTerms(filled: string, sent: string) {
  const split = (s: string) => s.split(/[\s,;:!?()"'`]+/).map(w => w.replace(/\.+$/, '')).filter(Boolean)
  const said = new Set(split(filled))
  const words = split(sent)
  if (words.filter(w => said.has(w)).length < said.size / 2) return [] // not an edit of the dictated text
  const isTechnical = (w: string) => /^[A-Za-z_$][\w$.\-/]*$/.test(w) && /[A-Z_$./\d]/.test(w.slice(1))
  return [...new Set(words.filter(w => !said.has(w) && isTechnical(w)))].slice(0, 10)
}

async function learn($: EngineInterface, filled: string, sent: string) {
  const add = newTerms(filled, sent)
  if (!add.length) return
  const merged = [...new Set([...add, ...(await learnedTerms($))])].slice(0, 200)
  await $.store.set('learned', merged)
  $.ui.toast(`📚 Learned: ${add.join(', ')}`)
  void refreshContext($)
}

// ---------- Recording ----------

let isActive = false
let isTentative = false // started on the 1st space of an empty prompt; cancelled when no repeat follows
let isCancelled = false
let isStopping = false
let isFinishing = false
let isPolishing = false
let isHeld = false
let lastPress = 0
let lastSpace: number | null = null // time of the last space typed with nothing else between
let startedAt = 0
let frame = 0 // animation step
let levels: number[] = [] // recent mic levels for the meter
let latest: Live = { fa: '', en: '' } // stream.py's last line, also while tentative (not drawn yet)
let lastFill: string | null = null // dictated text in the box, to learn from the person's edits

let isSpaceHold = false // this recording was started by holding Space (not the shortcut, button or /fa)

// Synchronous on purpose: the prompt.edit hook calls it before it answers the key (see there).
function begin($: EngineInterface, held: boolean, tentative = false) {
  isActive = true
  isSpaceHold = held
  isTentative = tentative
  isCancelled = isStopping = false
  isHeld = held
  lastPress = 0 // start() sets the clock times
  levels = []
  latest = { fa: '', en: '' }
  // A throw before start()'s own cleanup would leave isActive set for good (Space swallowed, no new recording).
  background(() =>
    start($).catch(async e => {
      isActive = isTentative = isPolishing = isFinishing = false
      $.ui.toast(`Voice error: ${String(e).slice(0, 120)}`)
      await update($, live, () => null)
    }),
  )
}

// The talk / Stop button, its shortcut, and `/fa`: press to start, press again to stop.
// A shortcut held down repeats; presses closer than HOLD_GAP_MS are that hold, and it ends on release.
async function press($: EngineInterface) {
  const now = await $.clock.now()
  if (!isActive) {
    begin($, false)
    lastPress = now
  } else if (isHeld || now - lastPress < HOLD_GAP_MS) {
    isHeld = true
    lastPress = now
  } else isStopping = true
}

// A held key's repeat: keep the recording alive (and show it, if it was tentative).
async function repeat($: EngineInterface) {
  const now = await $.clock.now()
  lastPress = Math.max(lastPress, now)
  if (isTentative) {
    isTentative = false
    await update($, live, () => ({ ...latest, ms: now - startedAt }))
  }
}

// Work left running after a hook returns; a hot reload aborts it, which is fine.
const background = (work: () => Promise<unknown>) => void work().catch(() => {})

const redraw = ($: EngineInterface) => update($, live, l => l && { ...l })

// Stream mic -> Soniox until Stop, clean up, then put the text in the prompt box (or send it).
async function start($: EngineInterface) {
  isFinishing = isPolishing = false
  startedAt = await $.clock.now()
  lastPress = Math.max(lastPress, startedAt)
  if (!isTentative) await update($, live, () => ({ fa: '', en: '', ms: 0 }))
  const p = await paths($)
  const env: Record<string, string> = { PATH, HOME: p.home, FA_STOP: STOP, FA_MIC: (await read($, prefs)).mic }
  if (context) env.FA_CONTEXT = context.json
  const proc = $.process.spawn({ argv: [p.python, p.script], env })
  let last: Live = { fa: '', en: '' }
  let err = ''
  let isRunning = true
  // Polls for cancel / Stop / release on its own, so it works even while stream.py prints nothing.
  background(async () => {
    let stopAt: number | null = null
    try {
      while (isRunning) {
        await $.clock.sleep(100)
        const now = await $.clock.now()
        if (isCancelled || (isTentative && now - lastPress > HOLD_GAP_MS)) {
          isCancelled = true // start() then drops the text
          await $.fs.write(STOP, '') // stream.py exits by itself...
          await $.clock.sleep(FINISH_MS)
          if (isRunning) await proc.return({ code: null, signal: null }) // ...or is killed
          return
        }
        if (stopAt === null && now - startedAt > MAX_MS) {
          isStopping = true
          $.ui.toast('🎙 Stopped after 5 minutes')
        }
        if (stopAt === null && (isStopping || (isHeld && now - lastPress > RELEASE_MS))) {
          stopAt = now
          isFinishing = true
          await redraw($)
          await $.fs.write(STOP, '') // stream.py closes the mic, waits for the last words, then exits
        }
        if (stopAt !== null && now - stopAt > FINISH_MS) {
          await proc.return({ code: null, signal: null }) // kills stream.py
          return
        }
      }
    } catch {
      // If this poller dies, nothing else would ever stop stream.py: kill it so start() can finish.
      if (isRunning) await proc.return({ code: null, signal: null }).catch(() => {})
    }
  })
  try {
    let buf = ''
    for await (const { stream, text } of proc) {
      if (stream === 'stderr') err += text
      else {
        buf += text
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          try { last = latest = JSON.parse(line) } catch { continue }
          frame++
          levels = [...levels.slice(-15), last.lvl ?? 0]
          const ms = (await $.clock.now()) - startedAt
          if (!isTentative) await update($, live, () => ({ ...last, ms }))
        }
      }
    }
  } catch (e) {
    err += String(e)
  } finally {
    isRunning = isFinishing = false
  }
  try {
    if (isCancelled) return
    const raw = last.en.trim()
    if (!raw) {
      $.ui.toast(`Voice: ${err.trim().split('\n').pop() || 'nothing heard'}`)
      return
    }
    const p = await loadPrefs($)
    const plain = preclean(raw)
    let text = plain
    // JEV decides for prompt/chat; no key, a timeout or an error falls back to the rule.
    const gate = p.mode === 'prompt' || p.mode === 'chat' ? await jevNeedsRewrite($, plain) : null
    if (gate ?? needsModel(p.mode, raw)) {
      isPolishing = true
      background(async () => {
        while (isPolishing) { // spinner
          await $.clock.sleep(120)
          frame++
          await redraw($)
        }
      })
      text = await polish($, p.mode, last.fa.trim(), plain).catch(() => plain)
      isPolishing = false
    }
    await put($, text, p.autoSend)
    if (text !== plain && !p.autoSend) {
      await update($, undo, () => ({ raw: plain, polished: text }))
      background(async () => {
        await $.clock.sleep(UNDO_MS)
        await update($, undo, u => (u?.polished === text ? null : u))
      })
    }
  } finally {
    isActive = isTentative = isPolishing = false
    await update($, live, () => null)
  }
}

// Inserts at the cursor with a separating space; with auto-send, sends the whole draft.
async function put($: EngineInterface, text: string, autoSend: boolean) {
  const box = await $.prompt.read()
  const before = box.text.slice(0, box.cursor)
  const piece = (before && !/\s$/.test(before) ? ' ' : '') + text
  if (autoSend) {
    await $.prompt.fill({ text: '', mode: 'replace' })
    lastFill = null
    // ponytail: the engine marks this submit as sent by the plugin (PromptSubmitArgs has no `origin`); a plugin cannot remove that label
    background(() => $.prompt.submit({ text: before + piece + box.text.slice(box.cursor) }))
    return
  }
  // fill, not submit: Enter sends it as the person's own prompt
  await $.prompt.fill({ text: piece, mode: 'insert' })
  lastFill = text
}

async function usePlain($: EngineInterface) {
  const u = await read($, undo)
  await update($, undo, () => null)
  if (!u) return
  const box = await $.prompt.read()
  if (!box.text.includes(u.polished)) {
    $.ui.toast('The text was edited, so it was not swapped')
    return
  }
  await $.prompt.fill({ text: box.text.replace(u.polished, u.raw), mode: 'replace' })
  lastFill = u.raw
}

// ---------- Commands ----------

const HELP = `Persian voice
  hold space    talk, release to finish
  /fa           settings: see and change everything below
  /fa rec       start / stop a recording without holding a key
  /fa key [k]   your own shortcut, e.g. /fa key ctrl+x v (press to start, again to stop); /fa key off
  /fa space     hold Space to talk on / off (off: Space only types)
  /fa mode [m]  cleanup: ${MODE_ORDER.join(' · ')}
  /fa polish    cleanup on / off (prompt <-> exact)
  /fa send      auto-send on / off
  /fa mic [n]   list / choose the microphone
  /fa terms     your word list for recognition (one per line, or "persian = english")
Modes:
${MODE_ORDER.map(m => `  ${m.padEnd(8)} ${MODES[m].about}`).join('\n')}
Tip: speak in short, complete sentences. Agents follow spoken-formal input better than casual speech.`

// The microphones ffmpeg sees, as [index, name].
async function listMics($: EngineInterface) {
  const r = await $.process
    .run(['ffmpeg', '-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
      env: { PATH, HOME: (await paths($)).home },
    })
    .catch(() => ({ stderr: '' }))
  const out = r.stderr.split('audio devices:')[1] ?? ''
  return [...out.matchAll(/\[(\d+)\] (.+)/g)].map(m => [m[1] ?? '', (m[2] ?? '').trim()] as const)
}

async function micCommand($: EngineInterface, arg?: string) {
  if (arg) return `🎙 Microphone: ${(await savePrefs($, { mic: arg })).mic}`
  const mics = await listMics($)
  const cur = (await loadPrefs($)).mic
  return mics.length
    ? `${mics.map(([n, name]) => `${n === cur ? '▶' : ' '} ${n}  ${name}`).join('\n')}\nChoose one: /fa mic <number>`
    : 'No microphones found (is ffmpeg installed?)'
}

async function termsCommand($: EngineInterface) {
  const [mine, learned] = await Promise.all([readTerms($), learnedTerms($)])
  return `Word list: ${(await paths($)).terms}\n  ${mine.words.length} words, ${mine.pairs.length} translations; ${learned.length} learned from your edits${
    learned.length ? `: ${learned.slice(0, 12).join(', ')}` : ''
  }\nThe project's file names, name and branch are added by themselves.`
}

// ---------- Settings dialog (/fa, or ⚙ in the band) ----------

const SETTINGS = 'fa-settings'
// Read once when the dialog opens: ffmpeg and the word file are too slow to read on every redraw.
let micOptions: { value: string; label: string }[] = []
let wordsInfo = ''

async function openSettings($: EngineInterface) {
  const [mics, mine, learned, p] = await Promise.all([listMics($), readTerms($), learnedTerms($), paths($)])
  micOptions = [{ value: 'default', label: 'System default' }, ...mics.map(([n, name]) => ({ value: n, label: name }))]
  wordsInfo = `${mine.words.length} words, ${mine.pairs.length} translations, ${learned.length} learned · ${p.terms.replace(p.home, '~')}`
  await applyPrefs($, await loadPrefs($))
  return $.ui.open({ id: SETTINGS, title: 'Persian Voice · settings', focus: true, closeOnEscape: true, rows: 22 })
}

async function shortcutFromDialog($: EngineInterface, value: string) {
  const reply = await keyCommand($, value.trim())
  $.ui.toast(reply.split('\n')[0] ?? reply)
}

// ---------- Drawing ----------

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BARS = ' ▁▂▃▄▅▆▇█'
const RED = '#e5534b'
const AMBER = '#d4a72c'
const ORANGE = '#d97757'
const GREEN = '#57ab5a'

const clockText = (ms = 0) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fa',
      description: 'Persian voice: settings · /fa rec records without holding · /fa help lists all commands',
    })
    await applyPrefs($, await loadPrefs($))
    const { terms } = await paths($)
    if (!(await $.fs.exists(terms).catch(() => true))) {
      await $.fs.write(terms,'# Persian voice: words for speech recognition, one per line.\n# A line "persian = english" sets a translation, for example:\n# دیپلوی = deploy\n')
    }
    void refreshContext($)
    return next(e)
  })

  // Hold space: on an empty prompt it starts at once (tentative, so the first words are kept) and
  // is cancelled when no key-repeat follows; in text, a 2nd space right after the 1st is the repeat.
  on('prompt.edit', async ($, e, next) => {
    const isBurst = !e.key && /^ {2,}$/.test(e.inputText) // repeats folded into one edit
    const isSpace = isBurst || (e.key ? e.key.key === ' ' || e.key.key === 'space' : e.inputText === ' ')
    if (isSpace && !isHoldSpace) return next(e) // `/fa space off`: Space only types
    if (!isSpace) {
      lastSpace = null
      if (isActive && isTentative) isCancelled = true // it was a leading space, then typing
      return next(e)
    }
    // The editor draws each key before this hook answers, so a swallowed space shows for the
    // time the answer takes: the cursor jumps right, then back. Held space repeats ~30 times a
    // second, so these paths answer at once and keep the clock work for afterwards.
    if (isActive) {
      if (!isSpaceHold) return next(e) // started by the shortcut, button or /fa: typing stays normal
      background(() => repeat($))
      return next({ ...e, inputText: '' })
    }
    if (e.text.trim() === '') {
      begin($, true, !isBurst)
      return next({ ...e, inputText: '' }) // a leading space is useless anyway
    }
    // In text a single space types as usual, so the time check costs no jump here.
    const now = await $.clock.now()
    if (isBurst || (lastSpace !== null && now - lastSpace < HOLD_GAP_MS)) {
      lastSpace = null
      begin($, true)
      // Delete the hold's first space, which typed before the repeat showed it was a hold.
      const c = e.cursor
      if (c > 0 && e.text[c - 1] === ' ' && e.start === c && e.end === c) {
        return next({ ...e, text: e.text.slice(0, c - 1) + e.text.slice(c), cursor: c - 1, start: c - 1, end: c - 1, inputText: '' })
      }
      return next({ ...e, inputText: '' })
    }
    lastSpace = now
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    if (r.drop !== undefined) return r
    if (lastFill && e.origin?.kind === 'composer') {
      const filled = lastFill
      background(() => learn($, filled, e.text))
      lastFill = null
    }
    return r
  })

  on('command.run', { command: 'fa' }, async ($, e) => {
    const [sub = '', arg] = e.args.trim().split(/\s+/)
    const rest = e.args.trim().slice(sub.length).trim() // a chord has a space: "ctrl+x v"
    if (sub === '' || sub === 'settings') {
      const r = await openSettings($)
      return { text: r.isPlaced ? '⚙ Persian Voice settings (Esc closes)' : HELP }
    }
    if (sub === 'rec') {
      const wasListening = isActive
      if (wasListening) isStopping = true
      else await press($)
      return { text: wasListening ? 'Stopping…' : '🎙 Listening. Run /fa rec again to stop.' }
    }
    if (sub === 'mode') {
      if (arg && !(arg in MODES)) return { text: `Unknown mode "${arg}". Modes: ${MODE_ORDER.join(', ')}` }
      const p = await setMode($, arg as Mode | undefined)
      return { text: `✨ Mode: ${MODES[p.mode].label}` }
    }
    if (sub === 'polish') {
      const p = await savePrefs($, { mode: (await loadPrefs($)).mode === 'exact' ? 'prompt' : 'exact' })
      return { text: `✨ Mode: ${MODES[p.mode].label}` }
    }
    if (sub === 'send') {
      const p = await savePrefs($, { autoSend: !(await loadPrefs($)).autoSend })
      return { text: p.autoSend ? '⏎ Auto-send on: the prompt is sent when you finish' : '⏎ Auto-send off: press Enter to send' }
    }
    if (sub === 'key') return { text: await keyCommand($, rest) }
    if (sub === 'space') return { text: await spaceCommand($, rest) }
    if (sub === 'mic') return { text: await micCommand($, arg) }
    if (sub === 'terms') return { text: await termsCommand($) }
    return { text: sub === 'help' ? HELP : `Unknown: /fa ${sub}\n\n${HELP}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [l, p, u, settings] = await Promise.all([read($, live), read($, prefs), read($, undo), $.settings.read()])
    const { Box, Button, Text } = $.ui.resolve(e)

    if (!l || isTentative) {
      const isVoiceOn = (settings.voice as { enabled?: boolean } | undefined)?.enabled === true
      return (
        <Box flexDirection="column">
          {isVoiceOn && p.holdSpace && (
            <Text color={AMBER}>⚠ Built-in /voice is on and takes Space: run /voice off (once) to use Persian hold-space.</Text>
          )}
          <Box gap={1}>
            {p.holdSpace && <Text color={RED}>🎙</Text>}
            {p.holdSpace && <Text dimColor>Hold space to talk</Text>}
            {/* With a shortcut, its chord presses this Button from the prompt (the Button must be drawn). */}
            {(p.shortcut || !p.holdSpace) && (
              <Button key="talk" label={p.shortcut ? `🎙 Talk (${p.shortcut})` : '🎙 Talk'} action={ACTION} onPress={() => press($)} />
            )}
            <Button key="mode" label={`✨ ${MODES[p.mode].label}`} onPress={() => setMode($)} />
            <Button key="send" label={p.autoSend ? '⏎ Auto-send' : '⏎ Manual send'} onPress={() => savePrefs($, { autoSend: !p.autoSend })} />
            <Button key="settings" label="⚙ Settings" onPress={() => openSettings($)} />
            {u && <Button key="undo" label="↩ Use plain translation" onPress={() => usePlain($)} />}
          </Box>
        </Box>
      )
    }

    const phase = isPolishing ? 'polish' : isFinishing ? 'finish' : 'rec'
    const color = phase === 'rec' ? RED : phase === 'finish' ? AMBER : ORANGE
    const spin = SPIN[frame % SPIN.length]
    const head =
      phase === 'rec'
        ? `${frame % 6 < 3 ? '●' : '○'} REC ${clockText(l.ms)}`
        : phase === 'finish'
          ? `${spin} Finishing translation…`
          : `${spin} Polishing · ${MODES[p.mode].label}…`
    const meter = levels.map(v => BARS[Math.round(Math.min(1, v) * 8)]).join('').padStart(16, ' ')
    const byKey = !isSpaceHold // started by the shortcut, the button or /fa
    const hint =
      phase !== 'rec'
        ? ''
        : !byKey
          ? 'release space to finish'
          : isHeld
            ? `release ${p.shortcut ?? 'the key'} to finish`
            : `${p.shortcut ? `${p.shortcut} or ` : ''}/fa rec to finish`
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Box gap={2}>
          <Text color={color} bold>{head}</Text>
          {phase === 'rec' && <Text color={GREEN}>{meter}</Text>}
          <Text dimColor>{hint}</Text>
        </Box>
        <Text bold wrap="truncate-start">{l.fa || 'Listening…'}</Text>
        <Text dimColor wrap="truncate-start">→ {l.en || '…'}</Text>
        {/* Drawn while the shortcut is held too: its repeats reach press() through this Button. */}
        {phase === 'rec' && byKey && (
          <Box>
            <Button key="stop" label={p.shortcut ? `⏹ Stop (${p.shortcut})` : '⏹ Stop'} action={ACTION} onPress={() => press($)} />
          </Box>
        )}
      </Box>
    )
  })

  // The settings dialog: every setting, its current value, and a control to change it.
  on('ui.render', { component: 'Pane', requestId: SETTINGS }, async ($, e) => {
    const p = await read($, prefs)
    const els = $.ui.resolve(e)
    if (!('Select' in els) || !('Input' in els)) {
      const { Text } = els // a surface without pickers: show the commands instead
      return <Text>{HELP}</Text>
    }
    const { Box, Button, Input, Select, Text } = els
    const LABEL = 18
    const onOff = (isOn: boolean) => (isOn ? '● On ' : '○ Off')
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={ORANGE}>How to start a recording</Text>
        <Box gap={1}>
          <Box width={LABEL}><Text>Hold Space</Text></Box>
          <Button key="space" label={onOff(p.holdSpace)} onPress={() => savePrefs($, { holdSpace: !p.holdSpace })} />
          <Text dimColor>{p.holdSpace ? 'hold Space to talk, release to finish' : 'Space only types'}</Text>
        </Box>
        <Box gap={1}>
          <Box width={LABEL}><Text>Shortcut</Text></Box>
          {p.shortcut && <Text bold>{p.shortcut}</Text>}
          {p.shortcut && <Button key="unbind" label="Remove" onPress={() => shortcutFromDialog($, 'off')} />}
          {!p.shortcut && <Input key="shortcut" placeholder="type one, e.g. ctrl+x v, then Enter" onSubmit={v => shortcutFromDialog($, v)} />}
        </Box>
        <Box paddingLeft={LABEL + 1}>
          <Text dimColor>Press the shortcut to start, and again to stop.</Text>
        </Box>

        <Box marginTop={1}><Text bold color={ORANGE}>What happens to your words</Text></Box>
        <Box gap={1}>
          <Box width={LABEL}><Text>Cleanup mode</Text></Box>
          <Select
            key="mode"
            options={MODE_ORDER.map(m => ({ value: m, label: MODES[m].label }))}
            value={p.mode}
            onSelect={v => setMode($, v as Mode)}
          />
        </Box>
        <Box paddingLeft={LABEL + 1}>
          <Text dimColor wrap="wrap">{MODES[p.mode].about}</Text>
        </Box>
        <Box gap={1}>
          <Box width={LABEL}><Text>Auto-send</Text></Box>
          <Button key="send" label={onOff(p.autoSend)} onPress={() => savePrefs($, { autoSend: !p.autoSend })} />
          <Text dimColor>{p.autoSend ? 'sent as soon as you finish' : 'goes into the prompt box; you press Enter'}</Text>
        </Box>

        <Box marginTop={1}><Text bold color={ORANGE}>Microphone and words</Text></Box>
        <Box gap={1}>
          <Box width={LABEL}><Text>Microphone</Text></Box>
          <Select key="mic" options={micOptions} value={p.mic} onSelect={v => savePrefs($, { mic: v })} />
        </Box>
        <Box gap={1}>
          <Box width={LABEL}><Text>Word list</Text></Box>
          <Text dimColor wrap="wrap">{wordsInfo}</Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>Tab moves · Enter changes · Esc closes · saved for all projects · /fa help lists commands</Text>
        </Box>
      </Box>
    )
  })
}
