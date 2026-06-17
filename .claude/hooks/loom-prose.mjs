#!/usr/bin/env node

// One script, three branches, dispatched by event:
//
//   PostToolUse(Read)                — a .loom file was opened
//   PreToolUse(Write|Edit|MultiEdit) — a write is about to land on a .loom file
//   SessionStart(compact)            — context was just compacted
//
// Reads happen constantly, so the Read branch stays light: it plants the
// literate-programming principle and points to the standard, without paying the
// full skill on every open. Writes happen rarely, so the Write branch injects
// the full standard directly from disk — deterministic, never relying on the
// agent recalling a read from upstream. Compaction is the one moment the
// standard can be evicted, so the compact branch re-injects it. Together the
// Write and compact branches cover both ways the standard leaves context:
// recency decay and compaction.
//
// The hook never blocks. It only adds context.
//
// Register in .claude/settings.json (see the settings block alongside this file).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const SKILL_PATH = resolve(PROJECT_DIR, '.claude/skills/prose/SKILL.md')

const readSkill = () => {
  try {
    return readFileSync(SKILL_PATH, 'utf8')
  } catch {
    return null
  }
}

const emit = (hookEventName, additionalContext) =>
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }),
  )

let data = ''
process.stdin.on('data', chunk => (data += chunk))
process.stdin.on('end', () => {
  try {
    const { hook_event_name, tool_name, tool_input, source } = JSON.parse(data || '{}')
    const file = tool_input?.file_path ?? tool_input?.path ?? ''

    // Read — light reference. No disk read, no full skill.
    if (hook_event_name === 'PostToolUse' && tool_name === 'Read') {
      if (!file.endsWith('.loom')) return
      emit(
        hook_event_name,
        [
          'You just opened a Loom file.',
          'Prose and code are equal halves of a program in literate programming:',
          'prose is the meaning, code is its implementation.',
          'The narrative drives structure — split or reorder a code block when it',
          'serves the prose; Tangle reassembles chunks in its own order regardless',
          'of how they sit in the source.',
          'The full prose standard is put in front of you when you write a Loom',
          'file; treat prose as first-class from the moment you read one.',
        ].join(' '),
      )
      return
    }

    // Write — inject the full standard from disk. The draft in this payload is
    // already composed, so the standard governs the corrected write that follows.
    if (
      hook_event_name === 'PreToolUse' &&
      (tool_name === 'Write' || tool_name === 'Edit' || tool_name === 'MultiEdit')
    ) {
      if (!file.endsWith('.loom')) return
      const skill = readSkill()
      emit(
        hook_event_name,
        [
          'You are about to write to a Loom file.',
          'Prose drives structure: splitting or reordering a code block to serve',
          'the narrative is a legitimate edit.',
          skill
            ? 'The full prose standard follows. Run its closing checklist question over ' +
            'the prose in this write, sentence by sentence. If any check fails, revise ' +
            'and write the corrected version.\n\n' +
            skill
            : 'Read .claude/skills/prose/SKILL.md and run its checklist over this write ' +
            'before it proceeds.',
        ].join(' '),
      )
      return
    }

    // Compact — the standard may have been summarised away. Put it back.
    // No file path on this event, so it re-injects on any compaction.
    if (hook_event_name === 'SessionStart' && source === 'compact') {
      const skill = readSkill()
      if (!skill) return
      emit(
        hook_event_name,
        'Context was just compacted and the Loom prose standard may have been ' +
        'summarised away. It governs every .loom file in this repository. ' +
        'The full standard follows.\n\n' +
        skill,
      )
      return
    }
  } catch {
    // never disrupt a tool or session event
  }
})
