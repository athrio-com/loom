#!/usr/bin/env node

// One script, three branches, dispatched by event:
//
//   PostToolUse(Read)                    — a .loom file was opened
//   PreToolUse(Write|Edit|MultiEdit)     — a write is about to land on a .loom file
//   SessionStart(startup|resume|compact) — a session began, or context was compacted
//
// The hook never emits the standard itself. Hook context is capped: the harness
// persists any additionalContext over ~2KB to a file and forwards only a 2KB
// preview, so a 21KB dump of the standard arrives cut off inside its first rule —
// the checklist never reaches the model. So every branch instead emits a short
// directive and points at the standard on disk. The full text reaches context
// only through an uncapped channel: the /prose skill, or a direct Read of the file.
//
// Reads happen constantly, so the Read branch is the lightest — it plants the
// literate principle and names the standard. A write is the moment the standard
// must be in hand, so the Write branch directs an immediate load. A session start,
// compaction included, is where the standard is absent or evicted, so that branch
// directs the same load up front.
//
// The Write branch also checks the text being written for one fault the standard
// names and agents repeat: a sentence that opens on a bare backticked name, such as
// "`passedOver` tells such a name". The standard gives every backticked identifier
// an article and a noun. The check reads only the text the write brings, so it warns
// about new prose and never about older prose the write leaves alone, and it reads
// only prose lines: it skips frontmatter, code blocks (from `=>` to `~` or the next
// heading), fenced regions, headings, and indented lines.
//
// The hook never blocks. It only adds a directive, or a warning.
//
// Register in .claude/settings.json (see the settings block alongside this file).

import { resolve } from 'node:path'

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const SKILL_PATH = resolve(PROJECT_DIR, '.claude/skills/prose/SKILL.md')

const emit = (hookEventName, additionalContext) =>
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }),
  )

// The one instruction every branch shares: pull the full standard in through a
// channel the harness does not truncate.
const LOAD =
  `Load the full Loom prose standard into context before any .loom work: ` +
  `run /prose, or Read ${SKILL_PATH}. ` +
  `The standard governs every .loom file in this repository.`

// The text a write brings: a whole file for Write, the replacements for Edit and MultiEdit.
const writtenText = (tool_name, tool_input) => {
  if (tool_name === 'Write') return tool_input?.content ?? ''
  if (tool_name === 'Edit') return tool_input?.new_string ?? ''
  return (tool_input?.edits ?? []).map(edit => edit?.new_string ?? '').join('\n')
}

// The prose lines of a text, by the Loom layers each line belongs to.
const proseLines = text => {
  const prose = []
  let inCode = false
  let inFence = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) inFence = !inFence
    else if (inFence) continue
    else if (trimmed === '=>') inCode = true
    else if (trimmed === '~' || trimmed.startsWith('#')) inCode = false
    else if (!inCode && trimmed !== '---' && !/^\s/.test(line) && trimmed !== '') prose.push(line)
  }
  return prose
}

// A sentence opens on a bare name when a backticked name starts a line, a list item,
// or a sentence, and a word in lower case, its verb, follows it.
const BARE_OPENING = /(?:^(?:[-*] |\d+\. )?|[.!?] +)(`[^`]+` +[a-z][^.!?]{0,40})/g

const bareOpenings = text =>
  proseLines(text).flatMap(line => [...line.matchAll(BARE_OPENING)].map(found => found[1].trim()))

const bareWarning = openings =>
  `Warning: ${openings.length === 1 ? 'a sentence' : `${openings.length} sentences`} in the ` +
  `text you are writing open on a bare backticked name: ` +
  openings.slice(0, 5).map(opening => `"${opening}…"`).join(', ') + '. ' +
  `The prose standard gives every backticked identifier an article and a noun ` +
  `("Prefer natural language"). Write "The function \`passedOver\` tells…", or open the ` +
  `sentence on what the reader already holds and name the identifier later in it. ` +
  `Revise these sentences in a follow-up edit.`

let data = ''
process.stdin.on('data', chunk => (data += chunk))
process.stdin.on('end', () => {
  try {
    const { hook_event_name, tool_name, tool_input } = JSON.parse(data || '{}')
    const file = tool_input?.file_path ?? tool_input?.path ?? ''

    // Read — light reference, plus a pointer to the standard.
    if (hook_event_name === 'PostToolUse' && tool_name === 'Read') {
      if (!file.endsWith('.loom')) return
      emit(
        hook_event_name,
        'You just opened a Loom file. Prose and code are equal halves of one ' +
        'program in literate programming: prose is the meaning, code is its ' +
        'implementation, and the narrative drives structure — split or reorder a ' +
        'code block when it serves the prose; Tangle reassembles chunks in its ' +
        'own order regardless. ' + LOAD,
      )
      return
    }

    // Write — the standard must be in hand. Direct an immediate load if it isn't.
    if (
      hook_event_name === 'PreToolUse' &&
      (tool_name === 'Write' || tool_name === 'Edit' || tool_name === 'MultiEdit')
    ) {
      if (!file.endsWith('.loom')) return
      const openings = bareOpenings(writtenText(tool_name, tool_input))
      emit(
        hook_event_name,
        (openings.length > 0 ? bareWarning(openings) + ' ' : '') +
        'You are about to write to a Loom file. The prose standard governs this ' +
        'edit: run its closing checklist over the prose, sentence by sentence, ' +
        'before presenting, and revise where a check fails. If you have not loaded ' +
        'the standard this session, load it first. ' + LOAD,
      )
      return
    }

    // Session start — startup, resume, or compaction. The standard is absent or
    // may have been summarised away, so direct the load up front.
    if (hook_event_name === 'SessionStart') {
      emit(hook_event_name, LOAD)
      return
    }
  } catch {
    // never disrupt a tool or session event
  }
})
