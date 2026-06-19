import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAnchorDelims } from '../src/PackageConfig'
import { defaultAnchorDelims } from '#ast/LoomTokens'

// resolveAnchorDelims is the editor's synchronous config read: given a file path,
// it walks up to the nearest loom.json and returns its anchor delimiters, the
// same answer the async tangler service gives — proving the editor and the CLI
// agree on a config file.
const run = (path: string) => Effect.runSync(resolveAnchorDelims(path))

const tempDir = () => mkdtempSync(join(tmpdir(), 'loom-cfg-'))

describe('resolveAnchorDelims — synchronous per-file config', () => {
  it("reads a package's loom.json anchor delimiters", () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'loom.json'),
      '{ "anchor": { "open": "<<", "close": ">>" } }',
    )
    expect(run(join(dir, 'a.loom'))).toEqual({ open: '<<', close: '>>' })
  })

  it('walks up to a parent loom.json', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'loom.json'),
      '{ "anchor": { "open": "@@", "close": "@@" } }',
    )
    const nested = join(dir, 'sub')
    mkdirSync(nested)
    expect(run(join(nested, 'b.loom'))).toEqual({ open: '@@', close: '@@' })
  })

  it('defaults when no loom.json is found', () => {
    expect(run(join(tempDir(), 'c.loom'))).toEqual(defaultAnchorDelims)
  })

  it('defaults for an empty (in-memory) path', () => {
    expect(run('')).toEqual(defaultAnchorDelims)
  })
})
