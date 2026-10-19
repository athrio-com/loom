import { Array, Context, Effect, Layer, Match, Option, Order, pipe } from 'effect'
import { fromProduct, rootNamesAt } from '#ast/LoomVirtualCodeBuilder'
import { LoomCorpusAstBuilder, ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import { outputPath } from './LoomCompiler'
import { type BuildSettings, PackageConfig } from './PackageConfig'
import { loomsIn, projectIn } from './LoomProject'
import { statSync } from 'node:fs'
import type { LoomDocument } from '@athrio/loom-ast/LoomAst'
import type { SectionBodyWeft } from '@athrio/loom-ast/Weft'
import type { LoomModule, Path } from '@athrio/loom-ast/LoomCorpusAst'
import type { Code } from '@athrio/loom-ast/ProductAst'
import type { LoomVirtualCode, Mapping } from '@athrio/loom-ast/LoomVirtualCode'
import type { AnchorDelims } from '@athrio/loom-ast/LoomTokens'
import type { LanguageService } from '@athrio/loom-lang-services/LanguageService'

export interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}

const byStart: Order.Order<Edit> = Order.combine(
  Order.mapInput(Order.Number, (edit: Edit) => edit.start),
  Order.mapInput(Order.Number, (edit: Edit) => edit.end),
)

export const applyEdits = (text: string, edits: ReadonlyArray<Edit>): string =>
  pipe(
    edits,
    Array.sort(Order.flip(byStart)),
    Array.reduce(text, (done, edit) => done.slice(0, edit.start) + edit.text + done.slice(edit.end)),
  )

const clashes = (kept: Edit, next: Edit): boolean =>
  next.start < kept.end || next.start === kept.start

const settle = (edits: ReadonlyArray<Edit>): ReadonlyArray<Edit> =>
  pipe(
    edits,
    Array.sort(byStart),
    Array.reduce([] as ReadonlyArray<Edit>, (kept, next) =>
      Option.match(Array.last(kept), {
        onNone: () => [next],
        onSome: (last) => (clashes(last, next) ? kept : [...kept, next]),
      }),
    ),
  )

interface ProseLine {
  readonly line: number
  readonly start: number
  readonly text: string
}

const isProseWeft = (weft: SectionBodyWeft): boolean => weft.type === 'ProseWeft'

const proseLinesOf = (doc: LoomDocument, text: string): ReadonlyArray<ProseLine> =>
  pipe(
    [
      ...doc.preamble,
      ...Array.flatMap(doc.sections, (section) => [
        ...section.preamble,
        ...Array.filter(section.code, isProseWeft),
      ]),
    ],
    Array.map((weft) => ({
      line: weft.position.start.line,
      start: weft.position.start.offset,
      text: text.slice(weft.position.start.offset, weft.position.end.offset).replace(/\r?\n$/, ''),
    })),
    Array.sort(Order.mapInput(Order.Number, (line: ProseLine) => line.start)),
  )

type LineKind = 'blank' | 'fixed' | 'item' | 'text'

interface KindedLine extends ProseLine {
  readonly kind: LineKind
}

const fenceLine = /^\s*```/
const noteLine = /^\s*:::(?:\[Note\].*|\s*)$/
const blockLine = /^ {0,3}(?:#{1,6}(?:\s|$)|>|\||<|\{\{|\[[^\]]+\]:\s)/
const thematicBreak = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const itemLine = /^\s*(?:[-*+]|\d{1,9}[.)])\s/

const onlyAnchor = (line: string, delims: AnchorDelims): boolean => {
  const trimmed = line.trim()
  return (
    trimmed.startsWith(delims.open) &&
    trimmed.endsWith(delims.close) &&
    trimmed.indexOf(delims.open, delims.open.length) === -1
  )
}

const kindOf = (line: string, delims: AnchorDelims): LineKind =>
  Match.value(line).pipe(
    Match.when((text) => text.trim() === '', () => 'blank' as const),
    Match.when(
      (text) =>
        noteLine.test(text) ||
        blockLine.test(text) ||
        thematicBreak.test(text) ||
        onlyAnchor(text, delims),
      () => 'fixed' as const,
    ),
    Match.when((text) => itemLine.test(text), () => 'item' as const),
    Match.orElse(() => 'text' as const),
  )

const kindsOf = (
  lines: ReadonlyArray<ProseLine>,
  delims: AnchorDelims,
): ReadonlyArray<KindedLine> =>
  Array.mapAccum(lines, false, (inFence, line) => {
    const fence = fenceLine.test(line.text)
    const kind = inFence || fence ? 'fixed' : kindOf(line.text, delims)
    return [inFence !== fence, { ...line, kind }]
  })[1]

const hardBreak = /(?: {2,}|\\)$/

const joins = (upper: KindedLine, lower: KindedLine): boolean =>
  lower.line === upper.line + 1 &&
  lower.kind === 'text' &&
  (upper.kind === 'text' || upper.kind === 'item') &&
  !hardBreak.test(upper.text)

const proseEdits = (
  doc: LoomDocument,
  text: string,
  delims: AnchorDelims,
): ReadonlyArray<Edit> => {
  const lines = kindsOf(proseLinesOf(doc, text), delims)
  return pipe(
    Array.zip(lines, Array.drop(lines, 1)),
    Array.filter(([upper, lower]) => joins(upper, lower)),
    Array.map(([upper, lower]) => ({
      start: upper.start + upper.text.trimEnd().length,
      end: lower.start + lower.text.length - lower.text.trimStart().length,
      text: ' ',
    })),
  )
}

interface Hunk<A> {
  readonly from: number
  readonly to: number
  readonly items: ReadonlyArray<A>
}

type Frontier = ReadonlyMap<number, number>

const slide = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>, x: number, y: number): number => {
  const room = Math.min(a.length - x, b.length - y)
  return room <= 0
    ? x
    : x +
        pipe(
          Array.findFirstIndex(Array.range(0, room - 1), (i) => a[x + i] !== b[y + i]),
          Option.getOrElse(() => room),
        )
}

const diagonals = (d: number): ReadonlyArray<number> =>
  Array.map(Array.range(0, d), (i) => 2 * i - d)

const movesDown = (k: number, d: number, previous: Frontier): boolean =>
  k === -d || (k !== d && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1))

const frontiersOf = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>): ReadonlyArray<Frontier> => {
  const search = (d: number, trace: ReadonlyArray<Frontier>): ReadonlyArray<Frontier> => {
    const previous = trace[trace.length - 1] ?? new Map([[1, 0]])
    const frontier: Frontier = new Map(
      Array.map(diagonals(d), (k) => {
        const start = movesDown(k, d, previous)
          ? (previous.get(k + 1) ?? 0)
          : (previous.get(k - 1) ?? 0) + 1
        return [k, slide(a, b, start, start - k)] as const
      }),
    )
    const reached = Array.some(
      diagonals(d),
      (k) => (frontier.get(k) ?? 0) >= a.length && (frontier.get(k) ?? 0) - k >= b.length,
    )
    return reached ? [...trace, frontier] : search(d + 1, [...trace, frontier])
  }
  return search(0, [])
}

type Step<A> = { readonly drop: true; readonly at: number } | { readonly drop: false; readonly at: number; readonly item: A }

const stepsOf = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>): ReadonlyArray<Step<A>> => {
  const frontiers = frontiersOf(a, b)
  return frontiers.length < 2 ? [] : pipe(
    Array.range(1, frontiers.length - 1),
    Array.reverse,
    Array.mapAccum({ x: a.length, y: b.length }, (point, d): [{ x: number; y: number }, Step<A>] => {
      const previous = frontiers[d - 1] ?? new Map()
      const k = point.x - point.y
      const down = movesDown(k, d, previous)
      const fromK = down ? k + 1 : k - 1
      const fromX = previous.get(fromK) ?? 0
      const fromY = fromX - fromK
      return [
        { x: fromX, y: fromY },
        down ? { drop: false, at: fromX, item: b[fromY] as A } : { drop: true, at: fromX },
      ]
    }),
    ([, steps]) => Array.reverse(steps),
  )
}

const hunksOf = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>): ReadonlyArray<Hunk<A>> =>
  Array.reduce(stepsOf(a, b), [] as ReadonlyArray<Hunk<A>>, (hunks, step) => {
    const open = Option.filter(Array.last(hunks), (hunk) => hunk.to === step.at)
    const grown = (hunk: Hunk<A>): Hunk<A> =>
      step.drop ? { ...hunk, to: hunk.to + 1 } : { ...hunk, items: [...hunk.items, step.item] }
    return Option.match(open, {
      onNone: () => [...hunks, grown({ from: step.at, to: step.at, items: [] })],
      onSome: (hunk) => [...Array.dropRight(hunks, 1), grown(hunk)],
    })
  })

const refineLimit = 4000

const linesOf = (text: string): ReadonlyArray<string> =>
  text === '' ? [] : text.split(/(?<=\n)/)

const diffOf = (before: string, after: string): ReadonlyArray<Edit> => {
  const lines = linesOf(before)
  const offsets = Array.mapAccum(lines, 0, (at, line) => [at + line.length, at])[1]
  const offsetOf = (index: number): number => offsets[index] ?? before.length
  return Array.flatMap(hunksOf(lines, linesOf(after)), (hunk) => {
    const start = offsetOf(hunk.from)
    const end = offsetOf(hunk.to)
    const old = before.slice(start, end)
    const replacement = hunk.items.join('')
    return old.length + replacement.length > refineLimit
      ? [{ start, end, text: replacement }]
      : Array.map(hunksOf(old.split(''), replacement.split('')), (piece) => ({
          start: start + piece.from,
          end: start + piece.to,
          text: piece.items.join(''),
        }))
  })
}

const verbatim = (text: string, code: string) => (mapping: Mapping): boolean =>
  mapping.kind === 'product' &&
  text.slice(mapping.source.start.offset, mapping.source.start.offset + mapping.genLength) ===
    code.slice(mapping.genStart, mapping.genStart + mapping.genLength)

const closing = /^[;,)\]}]/

const closedBefore = (
  holders: ReadonlyArray<Mapping>,
  change: Edit,
): Option.Option<Edit> =>
  change.start === change.end && closing.test(change.text)
    ? Option.map(
        Array.findFirst(holders, (mapping) => mapping.genStart + mapping.genLength === change.start),
        (mapping) => {
          const point = mapping.source.start.offset + mapping.genLength
          return { start: point, end: point, text: change.text }
        },
      )
    : Option.none()

const placed = (mappings: ReadonlyArray<Mapping>) => (change: Edit): Option.Option<Edit> => {
  const holders = Array.filter(
    mappings,
    (mapping) =>
      mapping.genStart <= change.start && change.end <= mapping.genStart + mapping.genLength,
  )
  const points = Array.dedupe(
    Array.map(holders, (mapping) => mapping.source.start.offset + change.start - mapping.genStart),
  )
  const settled =
    change.start < change.end ||
    holders.length > 1 ||
    Array.some(
      holders,
      (mapping) =>
        mapping.genStart < change.start && change.start < mapping.genStart + mapping.genLength,
    )
  return points.length === 1 && settled
    ? Option.some({ start: points[0], end: points[0] + change.end - change.start, text: change.text })
    : closedBefore(holders, change)
}

const keepEdges = (before: string, after: string): string =>
  before.trim() === ''
    ? before
    : `${/^\s*/.exec(before)?.[0] ?? ''}${after.trim()}${before.slice(before.trimEnd().length)}`

const blankChange = (code: string, change: Edit): boolean =>
  code.slice(change.start, change.end).trim() === '' && change.text.trim() === ''

const rootEdits = (text: string, root: LoomVirtualCode, formatted: string): ReadonlyArray<Edit> => {
  const place = placed(Array.filter(root.mappings, verbatim(text, root.code)))
  const placements = Array.map(diffOf(root.code, keepEdges(root.code, formatted)), (change) => ({
    change,
    edit: place(change),
  }))
  const stray = Array.some(
    placements,
    ({ change, edit }) => Option.isNone(edit) && !blankChange(root.code, change),
  )
  return stray ? [] : Array.getSomes(Array.map(placements, ({ edit }) => edit))
}

const composesWhole = (module: LoomModule): boolean =>
  Array.every(module.product?.code ?? [], (code) =>
    Array.every(code.fragments, (part) =>
      part.type === 'Fragment'
        ? part.health.status === 'ok'
        : Option.exists(part.target, (target) => target.path === module.path),
    ),
  )

const formatterFor = (
  languages: ReadonlyArray<LanguageService>,
  languageId: string,
): Option.Option<NonNullable<LanguageService['format']>> =>
  pipe(
    Array.findFirst(languages, (language) => language.id === languageId),
    Option.flatMapNullishOr((language) => language.format),
  )

const targetOf = (module: LoomModule, root: Code, settings: BuildSettings): string =>
  pipe(
    Array.findFirst(module.product?.files ?? [], (file) => file.code.origin.name === root.origin.name),
    Option.map((file) =>
      outputPath(Option.fromNullishOr(settings.packageRoot), module.path, file.path),
    ),
    Option.getOrElse(() => module.path),
  )

const codeEdits = (
  module: LoomModule,
  settings: BuildSettings,
  languages: ReadonlyArray<LanguageService>,
): Effect.Effect<ReadonlyArray<Edit>> => {
  const modules = new Map([[module.path, module]])
  const roots = rootNamesAt(modules, module.path)
  return composesWhole(module)
    ? Effect.map(
        Effect.forEach(
          Array.filter(module.product?.code ?? [], (code) => roots.has(code.origin.name.toLowerCase())),
          (root) =>
            Option.match(formatterFor(languages, root.languageId), {
              onNone: () => Effect.succeed([] as ReadonlyArray<Edit>),
              onSome: (format) => {
                const composed = fromProduct(modules, root.origin)
                return format({
                  code: composed.code,
                  path: targetOf(module, root, settings),
                  width: settings.width,
                }).pipe(
                  Effect.map((formatted) => rootEdits(module.text, composed, formatted)),
                  Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<Edit>)),
                )
              },
            }),
        ),
        Array.flatten,
      )
    : Effect.succeed([])
}

const textSource = (path: Path, text: string): Source => ({
  read: (at) =>
    at === path
      ? Effect.succeed(text)
      : Effect.fail(new ReadError({ path: at, cause: 'the formatter reads only the file it formats' })),
  list: Option.none(),
})

export class LoomFormatter extends Context.Service<LoomFormatter>()('LoomFormatter', {
  make: Effect.gen(function* () {
    const config = yield* PackageConfig
    const corpus = yield* LoomCorpusAstBuilder
    return {
      format: (
        path: Path,
        text: string,
        languages: ReadonlyArray<LanguageService>,
      ): Effect.Effect<string> =>
        Effect.gen(function* () {
          const settings = yield* config.resolve(path)
          const module = yield* corpus.build(
            textSource(path, text),
            path,
            settings.delims,
            settings.primaryLanguage,
            settings.variables,
          )
          const code = yield* codeEdits(module, settings, languages)
          return applyEdits(text, settle([...proseEdits(module.doc, text, settings.delims), ...code]))
        }),
      looms: (path: Path): Effect.Effect<ReadonlyArray<Path>> =>
        statSync(path, { throwIfNoEntry: false })?.isDirectory() === true
          ? Effect.map(config.resolve(path), (settings) => loomsIn(path, projectIn(settings)))
          : Effect.succeed([path]),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(LoomCorpusAstBuilder.layer),
  )
}
