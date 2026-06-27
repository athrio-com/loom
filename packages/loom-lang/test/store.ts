import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const serviceDir = resolve(__dirname, '../../loom-service-typescript')

// LanguageLoader.loadActive imports a built service from a Loom store. A test that
// exercises a loaded service builds the artifact, stands up a temp store with the
// package symlinked under it, and points LOOM_HOME at it — storeFor falls back to
// LOOM_HOME/services when no .loom store sits above the file. Returns the teardown.
export const serviceStore = (): (() => void) => {
  execSync('npx vite build', { cwd: serviceDir, stdio: 'pipe' })
  const home = mkdtempSync(join(tmpdir(), 'loom-store-'))
  const scope = join(home, 'services', 'node_modules', '@athrio')
  mkdirSync(scope, { recursive: true })
  symlinkSync(serviceDir, join(scope, 'loom-service-typescript'), 'dir')
  process.env.LOOM_HOME = home
  return () => {
    delete process.env.LOOM_HOME
    rmSync(home, { recursive: true, force: true })
  }
}
