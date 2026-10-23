import { describe, expect, it } from 'bun:test'
import { Effect, Result } from 'effect'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchedExecutable, fetchedTypeScriptDir, fetchTypeScript } from '../src/LoomStore'

const standInNpm = `#!/bin/sh
prefix=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then prefix="$2"; fi
  shift
done
echo install >> "$STAND_IN_LOG"
if [ "$STAND_IN_FAILS" = yes ]; then exit 1; fi
mkdir -p "$prefix/node_modules/typescript"
echo '{"name":"typescript","version":"7.0.0"}' > "$prefix/node_modules/typescript/package.json"
if [ "$STAND_IN_COMPANION" = yes ]; then
  mkdir -p "$prefix/node_modules/@typescript/typescript-$STAND_IN_PLATFORM/lib"
  printf '' > "$prefix/node_modules/@typescript/typescript-$STAND_IN_PLATFORM/lib/tsc"
fi
`

const version = '7.0.0-test'

const machine = () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'loom-fetch-')))
  const bin = join(folder, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'npm'), standInNpm, { mode: 0o755 })
  return { home: join(folder, 'home'), bin, log: join(folder, 'log') }
}

type Machine = ReturnType<typeof machine>

const fetchIn = async (place: Machine, companion: boolean, fails = false) => {
  const variables: Record<string, string> = {
    PATH: `${place.bin}:${process.env.PATH ?? ''}`,
    LOOM_HOME: place.home,
    STAND_IN_LOG: place.log,
    STAND_IN_COMPANION: companion ? 'yes' : 'no',
    STAND_IN_FAILS: fails ? 'yes' : 'no',
    STAND_IN_PLATFORM: `${process.platform}-${process.arch}`,
  }
  const saved = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]))
  Object.assign(process.env, variables)
  try {
    return await Effect.runPromise(Effect.result(fetchTypeScript(version)))
  } finally {
    Object.entries(saved).forEach(([name, value]) =>
      value === undefined ? delete process.env[name] : (process.env[name] = value),
    )
  }
}

const installs = (place: Machine): number =>
  existsSync(place.log) ? readFileSync(place.log, 'utf8').split('\n').filter(Boolean).length : 0

const leftovers = (place: Machine): ReadonlyArray<string> =>
  existsSync(join(place.home, 'typescript'))
    ? readdirSync(join(place.home, 'typescript')).filter((name) => name.includes('.partial-'))
    : []

describe.skipIf(process.platform === 'win32')('fetchTypeScript', () => {
  it('fetches TypeScript into its version\'s folder once, and returns the executable', async () => {
    const place = machine()
    const first = await fetchIn(place, true)
    const again = await fetchIn(place, true)
    process.env.LOOM_HOME = place.home
    const executable = fetchedExecutable(version)
    delete process.env.LOOM_HOME
    expect(Result.isSuccess(first) && first.success).toBe(executable)
    expect(Result.isSuccess(again)).toBe(true)
    expect(existsSync(executable)).toBe(true)
    expect(installs(place)).toBe(1)
    expect(leftovers(place)).toEqual([])
  })

  it('replaces a folder that lacks the executable on the next fetch', async () => {
    const place = machine()
    const broken = await fetchIn(place, false)
    process.env.LOOM_HOME = place.home
    const folder = fetchedTypeScriptDir(version)
    delete process.env.LOOM_HOME
    expect(Result.isFailure(broken) && String(broken.failure.cause)).toContain(folder)
    expect(existsSync(folder)).toBe(true)
    const repaired = await fetchIn(place, true)
    expect(Result.isSuccess(repaired)).toBe(true)
    expect(leftovers(place)).toEqual([])
  })

  it('leaves no partial folder after a failed install', async () => {
    const place = machine()
    const failed = await fetchIn(place, true, true)
    expect(Result.isFailure(failed)).toBe(true)
    expect(installs(place)).toBe(1)
    expect(leftovers(place)).toEqual([])
  })
})
