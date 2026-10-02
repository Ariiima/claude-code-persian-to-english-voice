/** One line of fa.py: what was said, its English version, the mic level; plus time since start. */
export type Live = { fa: string; en: string; lvl?: number; ms?: number; done?: boolean }

/** How the English is cleaned up before it goes into the prompt box. */
export type Mode = 'exact' | 'prompt' | 'chat' | 'spec' | 'commit'

/** The person's settings, global ($.store). */
export type Prefs = { mode: Mode; autoSend: boolean; mic: string }

/** The last polished fill, so "Use raw" can swap the plain translation back. */
export type Undo = { raw: string; polished: string }

declare module 'claude-code' {
  interface PluginState {
    'persian-voice': { live: Live | null; prefs: Prefs; undo: Undo | null }
  }
}
