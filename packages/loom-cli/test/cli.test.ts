import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The CLI is an Effect program over the tangler and the config writer; this
// exercises it as a real process. We run it from the package dir (so the tsx
// loader resolves) and pass absolute paths — the tangler writes each `{path}`
// sink next to the .loom it came from, so a doc in a temp dir emits its output
// there. The interactive `init` prompts need a real terminal, so they are
// verified by hand; here we cover the command surface a subprocess can reach.
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

::[g]
`

const tempDoc = (): { readonly dir: string; readonly doc: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-cli-'))
  const doc = join(dir, 'doc.loom')
  writeFileSync(doc, fixture)
  return { dir, doc }
}

// Each case spawns `node --import tsx src/main.ts` cold — transpiling the whole
// tangler path on the fly takes seconds, and the 5s default flakes when the first
// cold spawn runs under full-suite load. Give these subprocess tests headroom.
const SPAWN_TIMEOUT = 30_000

describe('loom cli', () => {
  it('tangles a file through the `tangle` command', () => {
    const { dir, doc } = tempDoc()
    loom(['tangle', doc])
    expect(readFileSync(join(dir, 'out.ts'), 'utf8')).toContain(
      'export const hi = "hello"',
    )
    rmSync(dir, { recursive: true, force: true })
  }, SPAWN_TIMEOUT)

  it('prints help listing its commands given no arguments', () => {
    const { stdout } = loom([])
    expect(stdout).toContain('tangle')
    expect(stdout).toContain('init')
  }, SPAWN_TIMEOUT)
})
