// The questions the plugin asks JEV (TypeSafe), as the API takes them. One proposition per noul;
// the code in register.tsx combines the answers. tools/jev_eval.py scores this same object on labelled cases.
// Question names never reach the model: the instructions and criteria carry the whole meaning.
export const JEV_QUESTIONS = {
  // Asked once per recording, before any rewrite. State: { recent_chat, spoken, prompt }.
  before: {
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
    chat_resolves_reference: {
      type: 'noul',
      instructions: 'Does `prompt` point at its target with a vague reference ("that bug", "it", "the file we changed") that `recent_chat` makes clear?',
      criteria: {
        true: '`prompt` uses a pronoun or vague phrase for its target, and `recent_chat` names the file, function, feature or error it means.',
        false: '`prompt` names its target itself, needs no target, or `recent_chat` does not tell which one it means.',
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
    mistranslated: {
      type: 'noul',
      instructions: '`spoken` is what the speaker said (Persian, English or mixed). `prompt` is a machine translation of it into English. Does `prompt` change, add or leave out a fact, name, number, file path, code term or request that `spoken` contains?',
      criteria: {
        true: 'At least one fact, name, number, path, code term or request differs between `spoken` and `prompt`, or is missing from `prompt`.',
        false: '`prompt` keeps every fact, name, number, path, code term and request of `spoken`; only wording, fillers or word order differ.',
      },
    },
    is_for_agent: {
      type: 'noul',
      instructions: 'Is `prompt` meant for the AI assistant: a request, an instruction or a question that it could act on or answer, on any topic (code, files, tools, writing, stories, analysis or anything else)?',
      criteria: {
        true: 'The speaker asks the assistant to do, analyze, write, explain or answer something, on any topic.',
        false: 'Talk to another person who is present, background speech, a reaction to something around the speaker, or words with no request or question.',
      },
    },
    is_irreversible: {
      type: 'noul',
      instructions: 'Does `prompt` ask the agent to do something that is hard or impossible to undo?',
      criteria: {
        true: 'Deletes files or data that git cannot restore, discards uncommitted work, rewrites or force-pushes git history, drops or changes a database, deploys, publishes, sends a message, or spends money.',
        false: 'Reads, explains, answers, or makes local changes to tracked files that git can undo, such as editing, renaming, committing, or running tests.',
      },
    },
    // The options are the rewrite prompts in prompts.ts (a test checks that the two lists match).
    kind: {
      type: 'choice',
      instructions: "Which kind of task does the speaker give in `prompt`? `spoken` holds the same words in the speaker's language.",
      criteria: {
        general: 'Any other request for the coding agent, such as running commands, git operations (commit, push, branch), setup or configuration, or a request that mixes several kinds.',
        bug: 'Something is broken or wrong and must be fixed or debugged: an error, a crash, a failing test, or wrong behavior.',
        feature: 'Add or change functionality: a new feature, option, command, endpoint, screen element or behavior.',
        refactor: 'Restructure or clean up existing code without changing what it does: rename, move, split, merge or simplify.',
        test: 'Write new tests or extend tests for existing code. A failing test that must be fixed is a bug.',
        review: 'Review code, a diff, a branch or a pull request, and report problems.',
        question: 'A question about the code, the project or a tool that asks for an answer or explanation, not for a change.',
        story: 'Analyze, critique or edit creative writing: a story, chapter, scene, character or dialogue.',
        spec: 'The speaker thinks aloud about a larger task, with goals, ideas and requirements to organize into a task spec.',
        commit: 'The speaker wants the text of a git commit message written: they ask for one, or dictate its content. Not a request to run the commit.',
      },
    },
  },
  // Asked after a rewrite. State: { recent_chat, spoken, draft, rewritten }.
  after: {
    adds_request: {
      type: 'noul',
      instructions: "`spoken` is the speaker's own words, `draft` a machine translation of them into English, and `rewritten` a cleaned-up version of `draft`. Does `rewritten` ask for a task, step, file, test, option or condition that is in neither `spoken` nor `draft`?",
      criteria: {
        true: '`rewritten` contains a request that the speaker never made, in `spoken` or in `draft`.',
        false: 'Every request in `rewritten` is in `spoken` or in `draft`. Formatting, order, headings, a name taken from `recent_chat` to make a vague reference exact, a goal that the speaker\'s words clearly imply (for example "Fix ..." when the speaker reports a failure), and one expert role sentence at the start (for example "Act as an experienced fiction editor.") do not count.',
      },
    },
    changes_fact: {
      type: 'noul',
      instructions: "`spoken` is the speaker's own words, `draft` a machine translation of them into English, and `rewritten` a cleaned-up version of `draft`. Does `rewritten` give a name, number, file path or code term a value that matches neither `spoken` nor `draft`?",
      criteria: {
        true: 'A value in `rewritten` matches neither `spoken` nor `draft`, for example a different number or file name.',
        false: 'Each value in `rewritten` matches `spoken` or `draft`, or comes from `recent_chat` to make a vague reference exact.',
      },
    },
    drops_fact: {
      type: 'noul',
      instructions: '`rewritten` is a cleaned-up version of `draft`. Does `rewritten` leave out a fact, name, number, file path, code term or request that `draft` contains?',
      criteria: {
        true: 'Something with meaning in `draft` is missing from `rewritten`.',
        false: "`rewritten` keeps every meaningful item of `draft`. Removed fillers, repetitions, corrected false starts, the speaker's words about the output format (for example \"write a commit message saying\"), and a translation error in `draft` that `rewritten` corrects to match `spoken` (the original speech) do not count.",
      },
    },
  },
}
