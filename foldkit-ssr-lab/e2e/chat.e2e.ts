import { Effect } from 'effect'
import { chromium, type Browser } from 'playwright-core'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const serverEntry = join(root, '..', 'src', 'chat', 'server.ts')
const port = 4392
const origin = `http://localhost:${port}`
const draftKey = 'foldkit-ssr-chat-draft'

type Check = { readonly label: string; readonly ok: boolean; readonly gap: boolean }

const checks: Array<Check> = []

const assert = (label: string, ok: boolean): Effect.Effect<void> =>
  Effect.sync(() => {
    checks.push({ label, ok, gap: false })
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  })

const backend = Effect.acquireRelease(
  Effect.sync(() =>
    Bun.spawn(['bun', serverEntry], {
      env: { ...process.env, PORT: String(port) },
      stdout: 'inherit',
      stderr: 'inherit',
    }),
  ),
  (proc) => Effect.sync(() => proc.kill()),
)

const waitReady = (tries: number): Effect.Effect<void> =>
  tries <= 0
    ? Effect.die(new Error('server never became ready'))
    : Effect.tryPromise(() =>
        fetch(origin).then((response) => {
          if (!response.ok) throw new Error('not ready')
        }),
      ).pipe(
        Effect.catchCause(() =>
          Effect.sleep('150 millis').pipe(Effect.andThen(waitReady(tries - 1))),
        ),
      )

const browser = Effect.acquireRelease(
  Effect.promise(() => chromium.launch({ channel: 'chrome', headless: true })),
  (instance: Browser) => Effect.promise(() => instance.close()),
)

const heldPage = (instance: Browser) =>
  Effect.gen(function* () {
    const context = yield* Effect.promise(() => instance.newContext())
    const page = yield* Effect.promise(() => context.newPage())
    const gate: { release: () => void } = { release: () => {} }
    const held = new Promise<void>((resolve) => {
      gate.release = resolve
    })
    yield* Effect.promise(() =>
      page.route('**/assets/*.js', async (route) => {
        await held
        await route.continue()
      }),
    )
    return { context, page, gate }
  })

const shellStreamsBeforeMessages = (instance: Browser) =>
  Effect.gen(function* () {
    yield* Effect.log('Streaming — the shell paints, then the messages arrive')
    const context = yield* Effect.promise(() => instance.newContext())
    const page = yield* Effect.promise(() => context.newPage())
    yield* Effect.promise(() => page.goto(origin, { waitUntil: 'commit' }))
    yield* Effect.promise(() => page.waitForSelector('.feed.skeleton'))
    const channels = yield* Effect.promise(() => page.locator('.tab').count())
    yield* assert('the channels paint with the shell', channels === 3)
    const early = yield* Effect.promise(() =>
      page.getByText('Green across the board').count(),
    )
    yield* assert('the messages are not in the shell', early === 0)
    yield* Effect.promise(() =>
      page.waitForSelector('text=Green across the board', { timeout: 4000 }),
    )
    yield* assert('the messages stream in after the shell', true)
    yield* Effect.promise(() => context.close())
  })

const draftSurvivesHydration = (instance: Browser) =>
  Effect.gen(function* () {
    yield* Effect.log('A draft typed before the client boots survives hydration')
    const { context, page, gate } = yield* heldPage(instance)
    yield* Effect.promise(() => page.goto(origin, { waitUntil: 'commit' }))
    yield* Effect.promise(() => page.waitForSelector('input.draft'))
    yield* Effect.promise(() => page.locator('input.draft').fill('a half-typed thought'))
    yield* Effect.sync(() => gate.release())
    yield* Effect.promise(() => page.waitForLoadState('networkidle'))
    yield* Effect.promise(() => page.waitForTimeout(300))
    const value = yield* Effect.promise(() => page.locator('input.draft').inputValue())
    yield* assert('the composer keeps a draft typed before hydration', value === 'a half-typed thought')
    yield* Effect.promise(() => context.close())
  })

const draftAutosavesAcrossReload = (instance: Browser) =>
  Effect.gen(function* () {
    yield* Effect.log('Autosave — a draft persists and a reload restores it')
    const context = yield* Effect.promise(() => instance.newContext())
    const page = yield* Effect.promise(() => context.newPage())
    yield* Effect.promise(() => page.goto(origin, { waitUntil: 'networkidle' }))
    yield* Effect.promise(() => page.locator('input.draft').fill('picking up where I left off'))
    yield* Effect.promise(() => page.waitForTimeout(150))
    const saved = yield* Effect.promise(() =>
      page.evaluate((key) => window.localStorage.getItem(key), draftKey),
    )
    yield* assert('the draft is saved to local storage', saved === 'picking up where I left off')
    yield* Effect.promise(() => page.reload({ waitUntil: 'networkidle' }))
    yield* Effect.promise(() => page.waitForTimeout(200))
    const restored = yield* Effect.promise(() => page.locator('input.draft').inputValue())
    yield* assert('the reload restores the saved draft', restored === 'picking up where I left off')
    yield* Effect.promise(() => context.close())
  })

const streamedFeedMerges = (instance: Browser) =>
  Effect.gen(function* () {
    yield* Effect.log('The streamed feed hydrates onto its nodes, it does not rebuild')
    const { context, page, gate } = yield* heldPage(instance)
    yield* Effect.promise(() => page.goto(origin, { waitUntil: 'commit' }))
    yield* Effect.promise(() =>
      page.waitForSelector('text=Green across the board', { timeout: 4000 }),
    )
    yield* Effect.promise(() =>
      page.evaluate(() => {
        const removed: Array<string> = []
        ;(window as unknown as { __feedRemoved: Array<string> }).__feedRemoved = removed
        const room = document.querySelector('[data-fk-boundary="messages"]')
        if (room !== null) {
          new MutationObserver((mutations) => {
            for (const mutation of mutations) {
              for (const node of Array.from(mutation.removedNodes)) {
                if (node.nodeType === 1 && (node as Element).tagName === 'LI') {
                  removed.push('LI')
                }
              }
            }
          }).observe(room, { childList: true, subtree: true })
        }
      }),
    )
    yield* Effect.sync(() => gate.release())
    yield* Effect.promise(() => page.waitForLoadState('networkidle'))
    yield* Effect.promise(() => page.waitForTimeout(300))
    const removed = yield* Effect.promise(() =>
      page.evaluate(() => (window as unknown as { __feedRemoved: Array<string> }).__feedRemoved),
    )
    yield* assert(`no message is rebuilt on hydration (removed: [${removed.join(', ')}])`, removed.length === 0)
    yield* Effect.promise(() => context.close())
  })

const switchingChannelLoads = (instance: Browser) =>
  Effect.gen(function* () {
    yield* Effect.log('Switching a channel loads its history in the browser')
    const context = yield* Effect.promise(() => instance.newContext())
    const page = yield* Effect.promise(() => context.newPage())
    yield* Effect.promise(() => page.goto(origin, { waitUntil: 'networkidle' }))
    yield* Effect.promise(() => page.getByText('# design').click())
    yield* Effect.promise(() =>
      page.waitForSelector('text=mint-on-dark palette', { timeout: 4000 }),
    )
    yield* assert('the design channel loads its own history', true)
    yield* Effect.promise(() => context.close())
  })

const report = Effect.gen(function* () {
  const passed = checks.filter((check) => check.ok).length
  const failures = checks.filter((check) => !check.ok).length
  yield* Effect.log(`${passed} passed, ${failures} failed`)
  if (failures > 0) {
    yield* Effect.fail(new Error(`${failures} failure(s)`))
  }
})

const program = Effect.gen(function* () {
  yield* backend
  yield* waitReady(80)
  const instance = yield* browser
  yield* shellStreamsBeforeMessages(instance)
  yield* draftSurvivesHydration(instance)
  yield* draftAutosavesAcrossReload(instance)
  yield* streamedFeedMerges(instance)
  yield* switchingChannelLoads(instance)
  yield* report
}).pipe(Effect.scoped)

Effect.runPromise(program).then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
