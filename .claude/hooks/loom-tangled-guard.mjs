#!/usr/bin/env node

// PreToolUse(Edit|Write|MultiEdit): keep hand edits out of what the book
// tangles, and keep tests in looms.
//
// Loom is written in Loom. A workspace's `.loom/loom.lock` lists every file its
// looms tangle, so the lock says which files are tangled output.
//
//   1. A file the lock lists is tangled output. The write is denied, and the
//      answer names the loom that tangles the file.
//   2. A test file the lock does not list is written by hand.
//      - One that does not exist yet would be a new hand-written test. The write
//        is denied: a test is written as sections of the chapter it checks.
//      - One that exists is a legacy test. An edit may keep it compiling. An
//        edit that adds a case is denied: the case belongs in a loom.
//
// Every other write passes. The hook sees only the Edit, Write and MultiEdit
// tools. A shell command that writes a file does not pass through it.
//
// Register in .claude/settings.json under PreToolUse.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'

const answer = (output) =>
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...output } }),
  )

const deny = (reason) =>
  answer({ permissionDecision: 'deny', permissionDecisionReason: reason })

// The nearest folder above a file that holds a tangle lock.
const workspaceOf = (dir) =>
  existsSync(join(dir, '.loom', 'loom.lock'))
    ? dir
    : dirname(dir) === dir
      ? undefined
      : workspaceOf(dirname(dir))

const tangledIn = (workspace) =>
  new Set(JSON.parse(readFileSync(join(workspace, '.loom', 'loom.lock'), 'utf8')).tangled ?? [])

const isTest = (path) =>
  /(^|\/)test\/.+\.(ts|tsx|mts|cts)$/.test(path) || /\.test\.(ts|tsx|mts|cts)$/.test(path)

// The cases and groups a piece of test code declares: `it(`, `it.effect(`,
// `test(`, `describe(`.
const casesIn = (text) => (text.match(/\b(?:it|test|describe)(?:\.\w+)*\s*\(/g) ?? []).length

// How many cases a write adds to the file as it stands.
const casesAdded = (tool, input, file) =>
  tool === 'Write'
    ? casesIn(input.content ?? '') - casesIn(readFileSync(file, 'utf8'))
    : (tool === 'MultiEdit' ? (input.edits ?? []) : [input]).reduce(
        (sum, edit) => sum + casesIn(edit.new_string ?? '') - casesIn(edit.old_string ?? ''),
        0,
      )

const loomsUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? entry.name === 'node_modules' || entry.name.startsWith('.')
        ? []
        : loomsUnder(join(dir, entry.name))
      : entry.name.endsWith('.loom')
        ? [join(dir, entry.name)]
        : [],
  )

const corpusOf = (workspace) => {
  const config = join(workspace, '.loom', 'config.yaml')
  const named = existsSync(config)
    ? readFileSync(config, 'utf8').match(/^corpus:\s*(\S+)/m)?.[1]
    : undefined
  return join(workspace, named ?? '.')
}

// A loom names what it tangles in two places: the `Package:` line of its
// frontmatter, a file or a folder, and the sinks in brackets on its headings,
// which are paths inside that folder.
const tangles = (text, path) => {
  const named = text.match(/^Package:\s*(\S+)/m)?.[1]
  if (named === undefined) return false
  if (named === path) return true
  const folder = extname(named) === '' ? named : dirname(named)
  return [...text.matchAll(/^#+ .*\[([^\]\n]+)\]/gm)].some(
    (sink) => join(folder, sink[1]) === path,
  )
}

const loomOf = (workspace, path) => {
  try {
    return loomsUnder(corpusOf(workspace)).find((loom) =>
      tangles(readFileSync(loom, 'utf8'), path),
    )
  } catch {
    return undefined
  }
}

let data = ''
process.stdin.on('data', (chunk) => (data += chunk))
process.stdin.on('end', () => {
  try {
    const { tool_name, tool_input } = JSON.parse(data || '{}')
    const given = tool_input?.file_path ?? ''
    if (given === '') return
    const file = resolve(given)
    if (/\/(node_modules|dist|out)\//.test(file)) return
    const workspace = workspaceOf(dirname(file))
    if (workspace === undefined) return
    const path = relative(workspace, file)

    if (tangledIn(workspace).has(path)) {
      const loom = loomOf(workspace, path)
      return deny(
        `${path} is tangled from the book, so a hand edit is lost at the next tangle. ` +
          (loom === undefined
            ? 'Edit the section of the loom that names this file'
            : `Edit ${relative(workspace, loom)}`) +
          ', then tangle it with the published loom CLI.',
      )
    }

    if (!isTest(path)) return

    if (!existsSync(file))
      return deny(
        `${path} would be a test written by hand. Tests are looms: write the cases as ` +
          'sections of the chapter whose code they check, add a section whose sink is ' +
          'this file, and tangle the chapter.',
      )

    if (casesAdded(tool_name, tool_input, file) > 0)
      return deny(
        `${path} is a legacy test written by hand, and this edit adds a case to it. ` +
          'Write the new case in the chapter whose code it checks, so it tangles to a ' +
          'test file of that chapter. A legacy test is edited only to keep it compiling.',
      )

    answer({
      additionalContext:
        `${path} is a legacy test written by hand. Edit it only to keep it compiling, ` +
        'and add no case to it. New cases are written in a loom.',
    })
  } catch {
    /* a guard that cannot read its input never blocks the write */
  }
})
