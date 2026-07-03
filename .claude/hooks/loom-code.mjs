#!/usr/bin/env node

// One script, three branches, dispatched by event:
//
//   PostToolUse(Read)                    — a .loom corpus was opened
//   PreToolUse(Write|Edit|MultiEdit)     — a write is about to land on code
//   SessionStart(startup|resume|compact) — a session began, or context was compacted
//
// The hook never emits the standard itself. Hook context is capped: the harness
// persists any additionalContext over ~2KB to a file and forwards only a 2KB
// preview, so a full dump of the standard would arrive cut off inside its first
// rule. So every branch instead emits a short directive and points at the
// standard on disk. The full text reaches context only through an uncapped
// channel: the /code skill, or a direct Read of the file.
//
// The code standard governs the code in every .loom corpus and the @athrio/*
// source those sections tangle to. Code is authored in .loom files, so the Read
// branch fires there. A write may land on a .loom or on hand-written TypeScript —
// a test, say — so the Write branch fires on both, and that is the moment the
// standard must be in hand. A session start, compaction included, is where the
// standard is absent or evicted, so that branch directs the load up front.
//
// This is the code counterpart to loom-prose.mjs. Prose governs the layer a
// person reads; this governs the layer that runs. Both fire on a .loom edit.
//
// The hook never blocks. It only adds a directive.
//
// Register in .claude/settings.json alongside loom-prose.mjs.

import { resolve } from 'node:path'

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const SKILL_PATH = resolve(PROJECT_DIR, '.claude/skills/code/SKILL.md')

const emit = (hookEventName, additionalContext) =>
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }),
  )

// The one instruction every branch shares: pull the full standard in through a
// channel the harness does not truncate.
const LOAD =
  `Load the full Loom code standard into context before writing or reviewing ` +
  `code: run /code, or Read ${SKILL_PATH}. ` +
  `It governs the code in every .loom corpus and every @athrio/* package — ` +
  `pure functional programming with Effect, end to end.`

// The files the code standard governs: a .loom corpus, or hand-written
// TypeScript. Tangled output is never edited by hand, and the prose, config,
// and hook files are not Effect code, so neither belongs here.
const isCode = (file) => /\.(loom|ts|tsx|mts|cts)$/.test(file)

let data = ''
process.stdin.on('data', (chunk) => (data += chunk))
process.stdin.on('end', () => {
  try {
    const { hook_event_name, tool_name, tool_input } = JSON.parse(data || '{}')
    const file = tool_input?.file_path ?? tool_input?.path ?? ''

    // Read — light reference when a corpus is opened, plus a pointer to the standard.
    if (hook_event_name === 'PostToolUse' && tool_name === 'Read') {
      if (!file.endsWith('.loom')) return
      emit(
        hook_event_name,
        'You just opened a Loom corpus. Its code sections are pure functional ' +
          'programming with Effect: model each component as an Effect.Service, ' +
          'dispatch a union with an exhaustive Match rather than an if/else ladder ' +
          'or a nested ternary, carry absence as an Option and failure as a tagged ' +
          'error, and transform with the Array module over pipe — never a loop or a ' +
          'let accumulator. ' + LOAD,
      )
      return
    }

    // Write — the standard must be in hand. Direct an immediate load if it isn't.
    if (
      hook_event_name === 'PreToolUse' &&
      (tool_name === 'Write' || tool_name === 'Edit' || tool_name === 'MultiEdit')
    ) {
      if (!isCode(file)) return
      emit(
        hook_event_name,
        'You are about to write code the Loom code standard governs. Run its ' +
          'closing checklist over the diff before presenting, then run bunx tsc ' +
          'and bun test. If you have not loaded the standard this session, load it ' +
          'first. ' + LOAD,
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
