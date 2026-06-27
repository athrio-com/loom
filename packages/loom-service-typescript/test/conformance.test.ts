import { Effect } from 'effect'
import { execSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  isLanguageService,
  TypescriptSdk,
} from '@athrio/loom-lang-services/LanguageService'
import { installHostRuntime } from '@athrio/loom-lang-services/Runtime'

// The conformance gate for the migration. The built service is loaded from a
// directory with NO node_modules: it can resolve effect, the SPI, or typescript
// nowhere of its own, so it runs purely on the runtime the host lends through the
// global. This is the shipped reality — a bundled host and a far-off store — that
// the unbundled e2e tests cannot reproduce, because there both sides share the
// workspace's one copy by luck. The original externalize-all build would fail the
// positive test here with MODULE_NOT_FOUND; the bridge build passes it.
const serviceDir = resolve(__dirname, '..')
const built = join(serviceDir, 'dist', 'index.js')

const isolate = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-isolated-'))
  cpSync(built, join(dir, 'index.js'))
  cpSync(`${built}.map`, join(dir, 'index.js.map'))
  return dir
}

const SLOW = 30_000

let withoutHost: string
let withHost: string

beforeAll(() => {
  execSync('npx vite build', { cwd: serviceDir, stdio: 'pipe' })
  withoutHost = isolate()
  withHost = isolate()
}, SLOW)

afterAll(() => {
  rmSync(withoutHost, { recursive: true, force: true })
  rmSync(withHost, { recursive: true, force: true })
  delete (globalThis as { __loomRuntime?: unknown }).__loomRuntime
})

describe('conformance — the service runs on the host runtime alone', () => {
  it('without the host runtime, loading fails with a clear message', async () => {
    delete (globalThis as { __loomRuntime?: unknown }).__loomRuntime
    await expect(
      import(pathToFileURL(join(withoutHost, 'index.js')).href),
    ).rejects.toThrow(/Loom host runtime is not installed/)
  })

  it('with the host runtime installed, the service loads and TypescriptSdk meets', async () => {
    installHostRuntime(ts)
    const loaded = (await import(
      pathToFileURL(join(withHost, 'index.js')).href
    )) as { default: unknown }
    const service = loaded.default

    // The default export is a real LanguageService for typescript — proving the
    // service brand from the host's SPI (read off the global) recognizes it.
    expect(isLanguageService(service)).toBe(true)
    expect((service as { id: string }).id).toBe('typescript')

    // Running the service's plugins Effect requires the host's TypescriptSdk tag.
    // If the service carried its own Effect or SPI copy, the tag would be a
    // different key and this would fail with a missing-service defect. It meets,
    // so effect and the SPI are the host's single instances.
    const plugins = await Effect.runPromise(
      (service as { plugins: (config: { settings: Record<string, unknown> }) => Effect.Effect<ReadonlyArray<{ name?: string }>, never, TypescriptSdk> })
        .plugins({ settings: {} })
        .pipe(Effect.provideService(TypescriptSdk, TypescriptSdk.make(ts))),
    )
    expect(plugins.length).toBeGreaterThan(0)
    expect(plugins[0]?.name).toContain('typescript')
  })
})
