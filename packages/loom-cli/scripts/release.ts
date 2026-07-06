import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = resolve(
  cli,
  '../../corpus/08-loom-builds-loom/10-packaging-loom-cli.loom',
)

const run = (cmd: string, args: ReadonlyArray<string>): void =>
  execFileSync(cmd, [...args], { cwd: cli, stdio: 'inherit' })

run('bun', ['test'])

const bumpMinor = (text: string): string =>
  text.replace(
    /("version": ")(\d+)\.(\d+)\.\d+(")/,
    (_m, pre, major, minor, post) => `${pre}${major}.${Number(minor) + 1}.0${post}`,
  )

const before = readFileSync(manifest, 'utf8')
const after = bumpMinor(before)
if (after === before) throw new Error('no "version" to bump in the manifest chapter')
writeFileSync(manifest, after)

const version = after.match(/"version": "([^"]+)"/)?.[1] ?? '?'
run('bun', ['run', 'build'])
run('bun', ['dist/main.js', 'tangle', manifest])
run('bun', ['publish'])
console.log(`released @athrio/loom-cli ${version}`)
