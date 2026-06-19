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
// The hook never blocks. It only adds a directive.
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
      emit(
        hook_event_name,
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
