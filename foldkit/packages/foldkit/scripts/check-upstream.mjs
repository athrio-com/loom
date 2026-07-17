// Reports whether this vendored fork of foldkit has fallen behind upstream.
// The fork's base version is pinned in package.json `forkedFrom`; this compares
// it against the latest release on the npm registry.
//
//   pnpm --filter foldkit check-upstream
//
// A non-zero exit means a newer upstream release exists and the fork should be
// reconciled — import the new release over the pristine base, rebase the port
// delta, and rebuild (see UPSTREAM.md).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { forkedFrom } = JSON.parse(
  readFileSync(resolve(packageDir, 'package.json'), 'utf8'),
)
const { name, version } = forkedFrom

let latest
try {
  latest = execFileSync('npm', ['view', name, 'version'], {
    encoding: 'utf8',
  }).trim()
} catch {
  console.error(`could not reach the npm registry to check ${name}.`)
  process.exit(2)
}

if (latest === version) {
  console.log(`up to date — forked from ${name}@${version}, the latest release.`)
} else {
  console.log(`behind — forked from ${name}@${version}; ${name}@${latest} is out.`)
  console.log(
    `reconcile: import ${name}@${latest} over the pristine base, rebase the ` +
      `port delta, rebuild (see UPSTREAM.md).`,
  )
  process.exitCode = 1
}
