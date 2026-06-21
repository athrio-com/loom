import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PackageConfig } from '../src/PackageConfig'
import { defaultAnchorDelims } from '#ast/LoomTokens'

// PackageConfig.resolve is the compiler's per-file settings read: given a file
// path, it walks up to the nearest loom.json (through @athrio/loom-config) and
// returns that package's anchor delimiters and primary language. The same read
// serves the editor's synchronous projection hook and the CLI tangler.
const run = (path: string) =>
  Effect.runSync(
    PackageConfig.pipe(
      Effect.flatMap((config) => config.resolve(path)),
      Effect.provide(PackageConfig.Default),
    ),
  )

const tempDir = () => mkdtempSync(join(tmpdir(), 'loom-cfg-'))

describe('PackageConfig.resolve — per-file build settings', () => {
  it("reads a package's anchor delimiters and primary language", () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'loom.json'),
      '{ "anchor": { "open": "<<", "close": ">>" }, "language": "typescript" }',
    )
    expect(run(join(dir, 'a.loom'))).toEqual({
      delims: { open: '<<', close: '>>' },
      primaryLanguage: 'typescript',
    })
  })

  it('fills each missing anchor side from the default pair', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'loom.json'), '{ "anchor": { "open": "<<" } }')
    expect(run(join(dir, 'a.loom'))).toEqual({
      delims: { open: '<<', close: defaultAnchorDelims.close },
      primaryLanguage: undefined,
    })
  })

  it('walks up to a parent loom.json', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'loom.json'), '{ "language": "bash" }')
    const nested = join(dir, 'sub')
    mkdirSync(nested)
    expect(run(join(nested, 'b.loom'))).toEqual({
      delims: defaultAnchorDelims,
      primaryLanguage: 'bash',
    })
  })

  it('defaults when no loom.json is found', () => {
    expect(run(join(tempDir(), 'c.loom'))).toEqual({
      delims: defaultAnchorDelims,
      primaryLanguage: undefined,
    })
  })

  it('defaults for an empty (in-memory) path', () => {
    expect(run('')).toEqual({
      delims: defaultAnchorDelims,
      primaryLanguage: undefined,
    })
  })
})
