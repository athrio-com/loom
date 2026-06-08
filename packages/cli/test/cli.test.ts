import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The CLI is a thin Effect program over the tangler; this exercises it as a real
// process. We run it from the package dir (so the tsx loader resolves) and pass
// absolute paths — the tangler writes each `{path}` sink next to the .loom it
// came from, so a doc in a temp dir emits its output there.
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const main = resolve(cli, 'src/main.ts')

const loom = (args: ReadonlyArray<string>) =>
  spawnSync('node', ['--import', 'tsx', main, ...args], {
    cwd: cli,
    encoding: 'utf8',
  })

const fixture = `{{lang: TypeScript}}

# Greeting [Greet]

=>

export const hi = "hello"

# Out {out.ts}

{{g: Greet}}

=>

{{g}}
`

const tempDoc = (): { readonly dir: string; readonly doc: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-cli-'))
  const doc = join(dir, 'doc.loom')
  writeFileSync(doc, fixture)
  return { dir, doc }
}

describe('loom cli', () => {
  it('tangles a bare path (tangle is the default command)', () => {
    const { dir, doc } = tempDoc()
    loom([doc])
    expect(readFileSync(join(dir, 'out.ts'), 'utf8')).toContain(
      'export const hi = "hello"',
    )
    rmSync(dir, { recursive: true, force: true })
  })

  it('tangles with an explicit `tangle` command too', () => {
    const { dir, doc } = tempDoc()
    loom(['tangle', doc])
    expect(readFileSync(join(dir, 'out.ts'), 'utf8')).toContain(
      'export const hi = "hello"',
    )
    rmSync(dir, { recursive: true, force: true })
  })

  it('prints usage given no arguments', () => {
    expect(loom([]).stderr).toContain('usage: loom')
  })
})
