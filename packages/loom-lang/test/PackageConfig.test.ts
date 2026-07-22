import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
const it = effectify(it_)
import { Effect } from 'effect'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PackageConfig } from '../src/PackageConfig'
import { defaultAnchorDelims } from '@athrio/loom-ast/LoomTokens'

// PackageConfig.resolve is the compiler's per-file settings read: given a file
// path, it walks up to the workspace's .loom/config.yaml (through
// @athrio/loom-config) and returns that file's anchor delimiters and primary
// language. The same read serves the editor's synchronous projection hook and
// the CLI tangler.
const run = (path: string) =>
  Effect.runSync(
    PackageConfig.pipe(
      Effect.flatMap((config) => config.resolve(path)),
      Effect.provide(PackageConfig.layer),
    ),
  )

const tempDir = () => mkdtempSync(join(tmpdir(), 'loom-cfg-'))

const writeConfig = (dir: string, yaml: string): void => {
  mkdirSync(join(dir, '.loom'), { recursive: true })
  writeFileSync(join(dir, '.loom', 'config.yaml'), yaml)
}

describe('PackageConfig.resolve — per-file build settings', () => {
  it("reads the workspace's anchor delimiters and primary language", () => {
    const dir = tempDir()
    writeConfig(dir, 'anchor:\n  open: "<<"\n  close: ">>"\nprimary: typescript\n')
    expect(run(join(dir, 'a.loom'))).toEqual({
      delims: { open: '<<', close: '>>' },
      primaryLanguage: 'typescript',
      variables: {},
      packageRoot: undefined,
      workspaceRoot: dir,
      corpusDir: dir,
    })
  })

  it('fills each missing anchor side from the default pair', () => {
    const dir = tempDir()
    writeConfig(dir, 'anchor:\n  open: "<<"\n')
    expect(run(join(dir, 'a.loom'))).toEqual({
      delims: { open: '<<', close: defaultAnchorDelims.close },
      primaryLanguage: undefined,
      variables: {},
      packageRoot: undefined,
      workspaceRoot: dir,
      corpusDir: dir,
    })
  })

  it('walks up to the workspace configuration', () => {
    const dir = tempDir()
    writeConfig(dir, 'primary: bash\n')
    const nested = join(dir, 'sub')
    mkdirSync(nested)
    expect(run(join(nested, 'b.loom'))).toEqual({
      delims: defaultAnchorDelims,
      primaryLanguage: 'bash',
      variables: {},
      packageRoot: undefined,
      workspaceRoot: dir,
      corpusDir: nested,
    })
  })

  it('defaults when no workspace is found', () => {
    expect(run(join(tempDir(), 'c.loom'))).toEqual({
      delims: defaultAnchorDelims,
      primaryLanguage: undefined,
      variables: {},
      packageRoot: undefined,
      workspaceRoot: undefined,
      corpusDir: undefined,
    })
  })

  it('defaults for an empty (in-memory) path', () => {
    expect(run('')).toEqual({
      delims: defaultAnchorDelims,
      primaryLanguage: undefined,
      variables: {},
      packageRoot: undefined,
      workspaceRoot: undefined,
      corpusDir: undefined,
    })
  })

  it('reads the header block that turns the generated-file banner on', () => {
    const dir = tempDir()
    writeConfig(dir, 'header:\n  ascii: true\n')
    expect(run(join(dir, 'a.loom')).header).toEqual({ ascii: true })
  })

  it('fills header.ascii to a definite false when the block omits it', () => {
    const dir = tempDir()
    writeConfig(dir, 'header: {}\n')
    expect(run(join(dir, 'a.loom')).header).toEqual({ ascii: false })
  })

  it('leaves the header unset when the workspace declares none', () => {
    const dir = tempDir()
    writeConfig(dir, 'primary: typescript\n')
    expect(run(join(dir, 'a.loom')).header).toBeUndefined()
  })
})
