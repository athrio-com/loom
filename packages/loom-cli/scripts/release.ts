import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = resolve(cli, 'corpus/package.loom')

const run = (cmd: string, args: ReadonlyArray<string>): void =>
  execFileSync(cmd, [...args], { cwd: cli, stdio: 'inherit' })

run('pnpm', ['test'])

const bumpMinor = (text: string): string =>
  text.replace(
    /("version": ")(\d+)\.(\d+)\.\d+(")/,
    (_m, pre, major, minor, post) => `${pre}${major}.${Number(minor) + 1}.0${post}`,
  )

const before = readFileSync(manifest, 'utf8')
const after = bumpMinor(before)
if (after === before) throw new Error('no "version" to bump in package.loom')
writeFileSync(manifest, after)

const version = after.match(/"version": "([^"]+)"/)?.[1] ?? '?'
run('tsx', ['src/main.ts', 'tangle', 'corpus'])
run('pnpm', ['publish', '--no-git-checks'])
console.log(`released @athrio/loom-cli ${version}`)
