import { describe, expect, it } from 'bun:test'
import { Effect, Layer, ManagedRuntime, Option } from 'effect'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URI } from 'vscode-uri'
import { DocumentSource } from '../src/LoomCompiler'
import { FileSystemSource, WorkspaceSource } from '../src/WorkspaceSource'

const runtime = ManagedRuntime.make(DocumentSource.layer.pipe(Layer.provideMerge(FileSystemSource)))

const source = () => runtime.runPromise(WorkspaceSource.pipe(Effect.map((s) => s)))

const folder = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)))

const workspace = () => {
  const root = folder('loom-workspace-')
  mkdirSync(join(root, '.loom'))
  mkdirSync(join(root, 'corpus', 'part'), { recursive: true })
  writeFileSync(join(root, '.loom', 'config.yaml'), 'corpus: corpus\n')
  const book = join(root, 'corpus', 'book.loom')
  const chapter = join(root, 'corpus', 'part', 'chapter.loom')
  writeFileSync(book, '# Book\n')
  writeFileSync(chapter, '# Chapter\n')
  return { root, book, chapter }
}

const looseLoom = () => {
  const root = folder('loom-loose-')
  const loom = join(root, 'loose.loom')
  writeFileSync(loom, '# Loose\n')
  return { root, loom }
}

describe('FileSystemSource — a workspace kept in a folder', () => {
  it('opens a workspace with its manifest and the text of every loom', async () => {
    const { root, book, chapter } = workspace()
    const opened = await runtime.runPromise(WorkspaceSource.pipe(Effect.flatMap((s) => s.open(root))))
    expect(opened.location).toBe(root)
    expect(Option.isSome(opened.manifest)).toBe(true)
    expect([...opened.looms.keys()].sort()).toEqual([book, chapter].sort())
    expect(opened.looms.get(chapter)).toBe('# Chapter\n')
  })

  it("names a loom's workspace, or its own folder when it has none", async () => {
    const { root, chapter } = workspace()
    const loose = looseLoom()
    const s = await source()
    expect(s.workspaceOf(chapter)).toBe(root)
    expect(s.workspaceOf(loose.loom)).toBe(loose.root)
  })

  it("lists a loom's corpus, or a loose loom's folder", async () => {
    const { book, chapter } = workspace()
    const loose = looseLoom()
    const s = await source()
    const corpus = (loom: string) => runtime.runPromise(s.corpusOf(loom))
    expect([...(await corpus(chapter))].sort()).toEqual([book, chapter].sort())
    expect(await corpus(loose.loom)).toEqual([loose.loom])
  })

  it('places a sink under the package root, or beside a loose loom', async () => {
    const { root, book } = workspace()
    const loose = looseLoom()
    const s = await source()
    const place = (loom: string, sink: string) => runtime.runPromise(s.placeOf(loom, sink))
    expect(await place(book, 'src/book.ts')).toBe(join(root, 'src', 'book.ts'))
    expect(await place(loose.loom, 'loose.ts')).toBe(join(loose.root, 'loose.ts'))
  })

  it('crosses between locations and URIs without losing a scheme', async () => {
    const { book } = workspace()
    const s = await source()
    expect(s.locationOf(URI.file(book))).toBe(book)
    expect(s.uriOf(book).toString()).toBe(URI.file(book).toString())
    expect(s.locationOf(URI.parse('memory:/a.loom'))).toBe('memory:/a.loom')
    expect(s.uriOf('memory:/a.loom').scheme).toBe('memory')
  })

  it('lets DocumentSource answer a held loom from memory and any other from disk', async () => {
    const { root, book } = workspace()
    const loose = looseLoom()
    const read = (path: string) =>
      runtime.runPromise(DocumentSource.pipe(Effect.flatMap((d) => d.read(path))))
    const opened = await runtime.runPromise(WorkspaceSource.pipe(Effect.flatMap((s) => s.open(root))))
    await runtime.runPromise(DocumentSource.pipe(Effect.flatMap((d) => d.hold(opened.looms))))
    writeFileSync(book, '# Rewritten\n')
    expect(await read(book)).toBe('# Book\n')
    expect(await read(loose.loom)).toBe('# Loose\n')
    await runtime.runPromise(DocumentSource.pipe(Effect.flatMap((d) => d.forget(book))))
    expect(await read(book)).toBe('# Rewritten\n')
  })
})
