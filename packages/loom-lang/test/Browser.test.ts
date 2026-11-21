import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { moduleOfText } from './browser/page'

const root = resolve(import.meta.dir, '../../..')

const page = join(import.meta.dir, 'browser', 'page.ts')

const modelPackage = join(root, 'packages', 'loom-ast')

const modelEntries: ReadonlyArray<string> = Object.values(
  (
    JSON.parse(readFileSync(join(modelPackage, 'package.json'), 'utf8')) as {
      readonly exports: Readonly<Record<string, string>>
    }
  ).exports,
).map((file) => join(modelPackage, file))

type Reached = { readonly module: string; readonly from: string }

const builtIns = new Set(builtinModules)

const builtIn = (name: string): boolean =>
  name === 'bun' || name.startsWith('bun:') || name.startsWith('node:') || builtIns.has(name)

const reachedBy = async (entries: ReadonlyArray<string>): Promise<ReadonlyArray<Reached>> => {
  const reached: Array<Reached> = []
  await Bun.build({
    entrypoints: [...entries],
    target: 'browser',
    format: 'esm',
    plugins: [
      {
        name: 'the built-in modules a page reaches',
        setup: (build) => {
          build.onResolve({ filter: /.*/ }, ({ path, importer }) => {
            if (builtIn(path) && importer.startsWith(root))
              reached.push({ module: path, from: relative(root, importer) })
            return undefined
          })
        },
      },
    ],
  })
  return reached
}

const bundleOf = async (entry: string, minify: boolean): Promise<string> => {
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify })
  const code = await Promise.all(built.outputs.map((output) => output.text()))
  return code.join('\n')
}

describe('a page that reads a loom', () => {
  const chapter = join(root, 'corpus', '03-reading-the-text', '02-classifying-lines.loom')

  it('reaches no module built into Node or into Bun', async () => {
    expect(await reachedBy([page, ...modelEntries])).toEqual([])
  })

  it('builds the module the command line builds', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'loom-page-')), 'page.js')
    writeFileSync(file, await bundleOf(page, false))
    const loaded = (await import(file)) as { readonly moduleOfText: typeof moduleOfText }
    const text = readFileSync(chapter, 'utf8')
    const inPage = await loaded.moduleOfText(chapter, text)
    const outside = await moduleOfText(chapter, text)
    expect(inPage.doc.sections.length).toBeGreaterThan(5)
    expect(JSON.stringify(inPage)).toBe(JSON.stringify(outside))
  })

  it('weighs less than a page should wait for', async () => {
    const weight = Bun.gzipSync(Buffer.from(await bundleOf(page, true))).length
    console.log(`size: a page that reads a loom loads ${Math.round(weight / 1024)} KB, compressed`)
    expect(weight).toBeLessThan(100 * 1024)
  })
})
