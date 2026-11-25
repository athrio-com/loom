import { describe, expect, it } from 'bun:test'
import { Effect, Layer, ManagedRuntime, Option } from 'effect'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
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

  it('opens a folder that holds no configuration with no manifest and no looms', async () => {
    const loose = looseLoom()
    const opened = await runtime.runPromise(
      WorkspaceSource.pipe(Effect.flatMap((s) => s.open(loose.root))),
    )
    expect(Option.isNone(opened.manifest)).toBe(true)
    expect(opened.looms.size).toBe(0)
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

  it('places the sinks of several looms, under the package root or beside a loose loom', async () => {
    const { root, book, chapter } = workspace()
    const loose = looseLoom()
    const s = await source()
    const placeOf = await runtime.runPromise(s.placesOf([book, chapter, loose.loom]))
    expect(placeOf(book, 'src/book.ts')).toBe(join(root, 'src', 'book.ts'))
    expect(placeOf(chapter, 'src/chapter.ts')).toBe(join(root, 'src', 'chapter.ts'))
    expect(placeOf(loose.loom, 'loose.ts')).toBe(join(loose.root, 'loose.ts'))
  })

  it('crosses between locations and URIs without losing a scheme', async () => {
    const { book } = workspace()
    const s = await source()
    expect(s.locationOf(URI.file(book))).toBe(book)
    expect(s.uriOf(book).toString()).toBe(URI.file(book).toString())
    expect(s.locationOf(URI.parse('memory:/a.loom'))).toBe('memory:/a.loom')
    expect(s.uriOf('memory:/a.loom').scheme).toBe('memory')
    expect(s.workspaceOf('memory:/a.loom')).toBe('memory:/a.loom')
    expect(s.workspaceOf('untitled:Untitled-1')).toBe('untitled:Untitled-1')
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

describe('FileSystemSource — a walk kept while its folders stand', () => {
  const listed = async (loom: string) =>
    [...(await runtime.runPromise(WorkspaceSource.pipe(Effect.flatMap((s) => s.corpusOf(loom)))))].sort()

  const stamped = (time: Date, paths: ReadonlyArray<string>) =>
    paths.forEach((path) => utimesSync(path, time, time))

  const longAgo = new Date(Date.now() - 60_000)

  const aged = (...paths: ReadonlyArray<string>) => stamped(longAgo, paths)

  const settledWorkspace = () => {
    const made = workspace()
    const corpus = join(made.root, 'corpus')
    const part = join(corpus, 'part')
    aged(corpus, part)
    return { ...made, corpus, part }
  }

  it('gives the kept list while every folder shows the time it showed', async () => {
    const { book, chapter, corpus } = settledWorkspace()
    expect(await listed(chapter)).toEqual([book, chapter].sort())
    writeFileSync(join(corpus, 'unseen.loom'), '# Unseen\n')
    aged(corpus)
    expect(await listed(chapter)).toEqual([book, chapter].sort())
  })

  it('walks again when a loom joins a folder it listed', async () => {
    const { book, chapter, part } = settledWorkspace()
    await listed(chapter)
    const added = join(part, 'added.loom')
    writeFileSync(added, '# Added\n')
    expect(await listed(chapter)).toEqual([added, book, chapter].sort())
  })

  it('walks again when a loom joins a folder that held none', async () => {
    const { book, chapter, corpus } = settledWorkspace()
    const empty = join(corpus, 'empty')
    mkdirSync(empty)
    aged(corpus, empty)
    await listed(chapter)
    const first = join(empty, 'first.loom')
    writeFileSync(first, '# First\n')
    expect(await listed(chapter)).toEqual([book, chapter, first].sort())
  })

  it('walks again when a folder below becomes a workspace of its own', async () => {
    const { book, chapter, part } = settledWorkspace()
    mkdirSync(join(part, '.loom'))
    aged(part)
    expect(await listed(book)).toEqual([book, chapter].sort())
    writeFileSync(join(part, '.loom', 'config.yaml'), 'corpus: corpus\n')
    expect(await listed(book)).toEqual([book])
  })

  it('keeps no walk of a folder whose time is not settled', async () => {
    const { book, chapter, corpus } = settledWorkspace()
    const ahead = new Date(Date.now() + 60_000)
    stamped(ahead, [corpus])
    expect(await listed(chapter)).toEqual([book, chapter].sort())
    const added = join(corpus, 'added.loom')
    writeFileSync(added, '# Added\n')
    stamped(ahead, [corpus])
    expect(await listed(chapter)).toEqual([added, book, chapter].sort())
  })
})

describe('FileSystemSource — the relations a folder keeps', () => {
  const keptRelationsOf = (loom: string) =>
    runtime.runPromise(WorkspaceSource.pipe(Effect.flatMap((s) => s.keptRelationsOf(loom))))

  it('are none before any were kept', async () => {
    const { book } = workspace()
    expect(await keptRelationsOf(book)).toEqual([])
  })

  it('come back as they were kept, and name each loom within the workspace', async () => {
    const { root, book, chapter } = workspace()
    const kept = [
      { loom: chapter, section: 'Chapter', kind: 'link', to: 'Book', fingerprint: 'approved' },
    ]
    await runtime.runPromise(
      WorkspaceSource.pipe(Effect.flatMap((s) => s.keepRelations(book, kept))),
    )
    expect(await keptRelationsOf(chapter)).toEqual(kept)
    expect(readFileSync(join(root, '.loom', 'relations.lock'), 'utf8')).toContain(
      '"loom":"corpus/part/chapter.loom"',
    )
  })
})
