import { Effect } from 'effect'
import { chromium, type Browser } from 'playwright-core'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const serverEntry = join(root, '..', 'src', 'server', 'server.ts')
const port = 4399
const origin = `http://localhost:${port}`
const storageKey = 'foldkit-ssr-todos'

type Check = { readonly label: string; readonly ok: boolean; readonly gap: boolean }

const checks: Array<Check> = []

const assert = (label: string, ok: boolean): Effect.Effect<void> =>
  Effect.sync(() => {
    checks.push({ label, ok, gap: false })
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  })

// A known gap: the behaviour we want but do not yet have. Recorded, never fatal,
// so the rest of the suite still runs. If it starts passing, the summary flags
// it — the cue to promote it from a gap to a guarantee.
const assertGap = (label: string, ok: boolean): Effect.Effect<void> =>
  Effect.sync(() => {
    checks.push({ label, ok, gap: true })
    console.log(`  ${ok ? '✓ (gap closed — promote this)' : '⚠ known gap'} ${label}`)
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

const recordChurn = () => {
  const removed: Array<string> = []
  const attrChanges: Array<string> = []
  const store = window as unknown as {
    __removed: Array<string>
    __attrChanges: Array<string>
  }
  store.__removed = removed
  store.__attrChanges = attrChanges
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.removedNodes)) {
        if (node.nodeType === 1) removed.push((node as Element).tagName)
      }
      if (
        mutation.type === 'attributes' &&
        mutation.target instanceof Element &&
        mutation.target.closest('#app') !== null
      ) {
        attrChanges.push(`${mutation.target.tagName}.${mutation.attributeName}`)
      }
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
  })
}

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

const firstPaint = (instance: Browser) =>
  Effect.gen(function* () {
    yield* Effect.log('First paint — the server response, before any JavaScript runs')
    const context = yield* Effect.promise(() => instance.newContext())
    const html = yield* Effect.promise(() =>
      context.request.get(origin).then((response) => response.text()),
    )
    yield* assert('the app root is server-rendered', html.includes('<div id="app" class="todo">'))
    yield* assert('a done task is checked', html.includes('<li class="item done" data-fk-key="0">'))
    yield* assert('an active task is clear', html.includes('<li class="item" data-fk-key="1">'))
    yield* Effect.promise(() => context.close())
  })

const mergeLeavesTheDomAlone = (instance: Browser) =>
  Effect.gen(function* () {
    yield* Effect.log('Hydration — a fresh visit merges the server DOM, it does not rebuild it')
    const context = yield* Effect.promise(() => instance.newContext())
    const page = yield* Effect.promise(() => context.newPage())
    yield* Effect.promise(() => page.addInitScript(recordChurn))
    yield* Effect.promise(() => page.goto(origin, { waitUntil: 'networkidle' }))
    yield* Effect.promise(() => page.waitForTimeout(300))
    const removed = yield* Effect.promise(() =>
      page.evaluate(() => (window as unknown as { __removed: Array<string> }).__removed),
    )
    yield* assert(`no element is removed (removed: [${removed.join(', ')}])`, removed.length === 0)
    const churn = yield* Effect.promise(() =>
      page.evaluate(() => (window as unknown as { __attrChanges: Array<string> }).__attrChanges),
    )
    yield* assert(`no attribute churns (changes: [${churn.join(', ')}])`, churn.length === 0)
    yield* Effect.promise(() => context.close())
  })

const changePersistsAcrossReload = (instance: Browser) =>
  Effect.gen(function* () {
    yield* Effect.log('Autosave and reconciliation — a change persists and a reload restores it over the seed')
    const context = yield* Effect.promise(() => instance.newContext())
    const page = yield* Effect.promise(() => context.newPage())
    yield* Effect.promise(() => page.goto(origin, { waitUntil: 'networkidle' }))
    yield* Effect.promise(() => page.waitForTimeout(200))
    const checkbox = page.locator('li[data-fk-key="1"] input.check')
    yield* Effect.promise(() => checkbox.click())
    yield* Effect.promise(() => page.waitForTimeout(100))
    const saved = yield* Effect.promise(() =>
      page.evaluate((key) => window.localStorage.getItem(key), storageKey),
    )
    yield* assert(
      'the change is saved to local storage',
      saved !== null && JSON.parse(saved).todos[1].done === true,
    )
    const serverAfter = yield* Effect.promise(() =>
      context.request.get(origin).then((response) => response.text()),
    )
    yield* assert(
      'the server still renders its unchanged seed',
      serverAfter.includes('<li class="item" data-fk-key="1">'),
    )
    yield* Effect.promise(() => page.reload({ waitUntil: 'networkidle' }))
    yield* Effect.promise(() => page.waitForTimeout(300))
    const restored = yield* Effect.promise(() => checkbox.isChecked())
    yield* assert('the reload restores the saved state over the seed', restored)
    yield* Effect.promise(() => context.close())
  })

const typedTextSurvives = (instance: Browser) =>
  Effect.gen(function* () {
    yield* Effect.log('Text typed before hydration — the capture script records it, the runtime replays it')
    const { context, page, gate } = yield* heldPage(instance)
    yield* Effect.promise(() => page.goto(origin, { waitUntil: 'commit' }))
    yield* Effect.promise(() => page.waitForSelector('input.new'))
    yield* Effect.promise(() => page.locator('input.new').fill('a half-typed todo'))
    yield* Effect.sync(() => gate.release())
    yield* Effect.promise(() => page.waitForLoadState('networkidle'))
    yield* Effect.promise(() => page.waitForTimeout(300))
    const value = yield* Effect.promise(() => page.locator('input.new').inputValue())
    yield* assert('a field keeps text typed before hydration', value === 'a half-typed todo')
    yield* Effect.promise(() => context.close())
  })

const interactivityNeedsHydration = (instance: Browser) =>
  Effect.gen(function* () {
    yield* Effect.log('Interactivity needs hydration — a click before the client boots does nothing')
    const { context, page, gate } = yield* heldPage(instance)
    const checkbox = page.locator('li[data-fk-key="1"] input.check')
    yield* Effect.promise(() => page.goto(origin, { waitUntil: 'commit' }))
    yield* Effect.promise(() => page.waitForSelector('li[data-fk-key="1"] input.check'))
    yield* Effect.promise(() => checkbox.click())
    const before = yield* Effect.promise(() =>
      page.evaluate((key) => window.localStorage.getItem(key), storageKey),
    )
    yield* assert('a click before hydration saves nothing — no handler is attached', before === null)
    yield* Effect.sync(() => gate.release())
    yield* Effect.promise(() => page.waitForLoadState('networkidle'))
    yield* Effect.promise(() => page.waitForTimeout(300))
    yield* Effect.promise(() => checkbox.click())
    const after = yield* Effect.promise(() =>
      page.evaluate((key) => window.localStorage.getItem(key), storageKey),
    )
    yield* assert('the same click after hydration is handled and saved', after !== null)
    yield* Effect.promise(() => context.close())
  })

const foreignAttributeReconciled = (instance: Browser) =>
  Effect.gen(function* () {
    yield* Effect.log('A foreign attribute on the app root is reconciled away on hydration')
    const { context, page, gate } = yield* heldPage(instance)
    yield* Effect.promise(() => page.goto(origin, { waitUntil: 'commit' }))
    yield* Effect.promise(() => page.waitForSelector('#app'))
    yield* Effect.promise(() =>
      page.evaluate(() => document.getElementById('app')?.setAttribute('data-extension', 'x')),
    )
    yield* Effect.sync(() => gate.release())
    yield* Effect.promise(() => page.waitForLoadState('networkidle'))
    yield* Effect.promise(() => page.waitForTimeout(300))
    const present = yield* Effect.promise(() =>
      page.evaluate(() => document.getElementById('app')?.hasAttribute('data-extension')),
    )
    yield* assert('the injected attribute is gone after hydration', present === false)
    yield* Effect.promise(() => context.close())
  })

const report = Effect.gen(function* () {
  const passed = checks.filter((check) => check.ok && !check.gap).length
  const gaps = checks.filter((check) => !check.ok && check.gap).length
  const closing = checks.filter((check) => check.ok && check.gap).length
  const failures = checks.filter((check) => !check.ok && !check.gap).length
  yield* Effect.log(`${passed} passed, ${gaps} known gaps, ${failures} unexpected failures`)
  if (closing > 0) {
    yield* Effect.log(`${closing} known gap(s) now pass — promote them from gaps to guarantees`)
  }
  if (failures > 0) {
    yield* Effect.fail(new Error(`${failures} unexpected failure(s)`))
  }
})

const program = Effect.gen(function* () {
  yield* backend
  yield* waitReady(80)
  const instance = yield* browser
  yield* firstPaint(instance)
  yield* mergeLeavesTheDomAlone(instance)
  yield* changePersistsAcrossReload(instance)
  yield* typedTextSurvives(instance)
  yield* interactivityNeedsHydration(instance)
  yield* foreignAttributeReconciled(instance)
  yield* report
}).pipe(Effect.scoped)

Effect.runPromise(program).then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
