import { Array, Context, Effect, Layer, Match, Option, Order, pipe } from 'effect'
import { fromProduct, rootNamesAt } from '#ast/LoomVirtualCodeBuilder'
import { sectionNameOf } from '#ast/ProductBuilder'
import { LoomCorpusAstBuilder, ReadError, type Source } from '#ast/LoomCorpusAstBuilder'
import { outputPath } from './LoomCompiler'
import { type BuildSettings, PackageConfig } from './PackageConfig'
import { loomsIn, projectIn } from './LoomProject'
import { statSync } from 'node:fs'
import type { LoomDocument, LoomSection } from '@athrio/loom-ast/LoomAst'
import type { CodeWeft, SectionBodyWeft } from '@athrio/loom-ast/Weft'
import type { LoomModule, Path } from '@athrio/loom-ast/LoomCorpusAst'
import type { Code } from '@athrio/loom-ast/ProductAst'
import type { LoomVirtualCode } from '@athrio/loom-ast/LoomVirtualCode'
import type { AnchorDelims, WarpAnchorToken } from '@athrio/loom-ast/LoomTokens'
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
    Array.reduce(
      text,
      (done, edit) => done.slice(0, edit.start) + edit.text + done.slice(edit.end),
    ),
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
    Match.when(
      (text) => text.trim() === '',
      () => 'blank' as const,
    ),
    Match.when(
      (text) =>
        noteLine.test(text) ||
        blockLine.test(text) ||
        thematicBreak.test(text) ||
        onlyAnchor(text, delims),
      () => 'fixed' as const,
    ),
    Match.when(
      (text) => itemLine.test(text),
      () => 'item' as const,
    ),
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

const proseEdits = (doc: LoomDocument, text: string, delims: AnchorDelims): ReadonlyArray<Edit> => {
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

type Step<A> =
  | { readonly drop: true; readonly at: number }
  | { readonly drop: false; readonly at: number; readonly item: A }

const stepsOf = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>): ReadonlyArray<Step<A>> => {
  const frontiers = frontiersOf(a, b)
  return frontiers.length < 2
    ? []
    : pipe(
        Array.range(1, frontiers.length - 1),
        Array.reverse,
        Array.mapAccum(
          { x: a.length, y: b.length },
          (point, d): [{ x: number; y: number }, Step<A>] => {
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
          },
        ),
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

const linesOf = (text: string): ReadonlyArray<string> => (text === '' ? [] : text.split(/(?<=\n)/))

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

interface Span {
  readonly genStart: number
  readonly genLength: number
  readonly sourceStart: number
}

const spanEnd = (span: Span): number => span.genStart + span.genLength

const closing = /^[;,)\]}]/
const spaces = /^[ \t]+$/

const inIndentation = (code: string, at: number): boolean =>
  /^[ \t]*$/.test(code.slice(code.lastIndexOf('\n', at - 1) + 1, at))

const insertedAt = (point: number, change: Edit): Edit => ({
  start: point,
  end: point,
  text: change.text,
})

const startOf = (spans: ReadonlyArray<Span>, at: number, change: Edit): Option.Option<Edit> =>
  Option.map(
    Array.findFirst(spans, (span) => span.genStart === at),
    (span) => insertedAt(span.sourceStart, change),
  )

const endOf = (spans: ReadonlyArray<Span>, at: number, change: Edit): Option.Option<Edit> =>
  Option.map(
    Array.findFirst(spans, (span) => spanEnd(span) === at),
    (span) => insertedAt(span.sourceStart + span.genLength, change),
  )

const atEdge = (spans: ReadonlyArray<Span>, change: Edit, code: string): Option.Option<Edit> =>
  Match.value(change).pipe(
    Match.when(
      (edit) => edit.start !== edit.end,
      () => Option.none(),
    ),
    Match.when(
      (edit) => closing.test(edit.text) || edit.start === code.length,
      (edit) => endOf(spans, edit.start, edit),
    ),
    Match.when(
      (edit) => (spaces.test(edit.text) && inIndentation(code, edit.start)) || edit.start === 0,
      (edit) => startOf(spans, edit.start, edit),
    ),
    Match.orElse(() => Option.none()),
  )

const placed =
  (spans: ReadonlyArray<Span>, code: string) =>
  (change: Edit): Option.Option<Edit> => {
    const holders = Array.filter(
      spans,
      (span) => span.genStart <= change.start && change.end <= spanEnd(span),
    )
    const points = Array.dedupe(
      Array.map(holders, (span) => span.sourceStart + change.start - span.genStart),
    )
    const settled =
      change.start < change.end ||
      holders.length > 1 ||
      Array.some(holders, (span) => span.genStart < change.start && change.start < spanEnd(span))
    return points.length === 1 && settled
      ? Option.some({
          start: points[0],
          end: points[0] + change.end - change.start,
          text: change.text,
        })
      : atEdge(holders, change, code)
  }

const blankChange = (code: string, change: Edit): boolean =>
  code.slice(change.start, change.end).trim() === '' && change.text.trim() === ''

const editsOf = (
  before: string,
  after: string,
  spans: ReadonlyArray<Span>,
): Option.Option<ReadonlyArray<Edit>> => {
  const place = placed(spans, before)
  const placements = Array.map(diffOf(before, after), (change) => ({
    change,
    edit: place(change),
  }))
  return Array.some(
    placements,
    ({ change, edit }) => Option.isNone(edit) && !blankChange(before, change),
  )
    ? Option.none()
    : Option.some(Array.getSomes(Array.map(placements, ({ edit }) => edit)))
}

interface Block {
  readonly start: number
  readonly end: number
}

const lineEnd = (weft: CodeWeft, text: string): number =>
  weft.position.start.offset +
  text.slice(weft.position.start.offset, weft.position.end.offset).replace(/\r?\n$/, '').length

const written =
  (text: string) =>
  (weft: CodeWeft): boolean =>
    text.slice(weft.position.start.offset, lineEnd(weft, text)).trim() !== ''

const runsOf = (section: LoomSection): ReadonlyArray<ReadonlyArray<CodeWeft>> =>
  Array.reduce(section.code, [[]] as ReadonlyArray<ReadonlyArray<CodeWeft>>, (runs, weft) =>
    weft.type === 'CodeWeft'
      ? [
          ...Array.dropRight(runs, 1),
          [...Option.getOrElse(Array.last(runs), (): ReadonlyArray<CodeWeft> => []), weft],
        ]
      : [...runs, []],
  )

const blocksOf = (section: LoomSection, text: string): ReadonlyArray<Block> =>
  pipe(
    runsOf(section),
    Array.map(Array.filter(written(text))),
    Array.map((run) =>
      Option.map(Option.all([Array.head(run), Array.last(run)]), ([first, last]) => ({
        start: first.position.start.offset,
        end: lineEnd(last, text),
      })),
    ),
    Array.getSomes,
  )

interface HeldAnchor {
  readonly at: number
  readonly text: string
  readonly placeholder: string
  readonly ownsLine: boolean
}

const ownsLine = (text: string, start: number, end: number): boolean => {
  const next = text.indexOf('\n', end)
  return (
    text.slice(text.lastIndexOf('\n', start - 1) + 1, start).trim() === '' &&
    text.slice(end, next === -1 ? text.length : next).trim() === ''
  )
}

const placeholderFor = (index: number, length: number): string => `_lm${index}`.padEnd(length, '_')

interface Held {
  readonly written: string
  readonly code: string
  readonly spans: ReadonlyArray<Span>
  readonly anchors: ReadonlyArray<HeldAnchor>
}

const anchorsIn = (section: LoomSection): ReadonlyArray<WarpAnchorToken> =>
  Array.flatMap(section.code, (weft) => (weft.type === 'CodeWeft' ? weft.anchors : []))

const heldOf = (section: LoomSection, text: string): Held => {
  const blocks = blocksOf(section, text)
  const spans = Array.mapAccum(blocks, 0, (at, block): [number, Span] => [
    at + block.end - block.start + 1,
    { genStart: at, genLength: block.end - block.start, sourceStart: block.start },
  ])[1]
  const written = Array.map(blocks, (block) => text.slice(block.start, block.end)).join('\n')
  const anchors = pipe(
    anchorsIn(section),
    Array.map((token) => ({ start: token.position.start.offset, end: token.position.end.offset })),
    Array.map((anchor) =>
      Option.map(
        Array.findFirst(
          spans,
          (span) =>
            span.sourceStart <= anchor.start && anchor.end <= span.sourceStart + span.genLength,
        ),
        (span) => ({ ...anchor, at: span.genStart + anchor.start - span.sourceStart }),
      ),
    ),
    Array.getSomes,
    Array.map((anchor, index): HeldAnchor => ({
      at: anchor.at,
      text: text.slice(anchor.start, anchor.end),
      placeholder: placeholderFor(index, anchor.end - anchor.start),
      ownsLine: ownsLine(text, anchor.start, anchor.end),
    })),
  )
  const code = pipe(
    anchors,
    Array.sort(Order.flip(Order.mapInput(Order.Number, (anchor: HeldAnchor) => anchor.at))),
    Array.reduce(
      written,
      (done, anchor) =>
        done.slice(0, anchor.at) + anchor.placeholder + done.slice(anchor.at + anchor.text.length),
    ),
  )
  return { written, code, spans, anchors }
}

const identifierPart = /[\w$]/

const restoredOne = (code: string, anchor: HeldAnchor): Option.Option<string> => {
  const at = code.indexOf(anchor.placeholder)
  const after = at + anchor.placeholder.length
  const whole =
    at !== -1 &&
    code.indexOf(anchor.placeholder, after) === -1 &&
    !identifierPart.test(code.charAt(at - 1)) &&
    !identifierPart.test(code.charAt(after))
  const ending = anchor.ownsLine && /^[;,]/.test(code.slice(after)) ? 1 : 0
  const back = code.slice(0, at) + anchor.text + code.slice(after + ending)
  return whole && ownsLine(back, at, at + anchor.text.length) === anchor.ownsLine
    ? Option.some(back)
    : Option.none()
}

const restored = (code: string, anchors: ReadonlyArray<HeldAnchor>): Option.Option<string> =>
  Array.reduce(anchors, Option.some(code), (done, anchor) =>
    Option.flatMap(done, (text) => restoredOne(text, anchor)),
  )

type Formatter = NonNullable<LanguageService['format']>

const aloneEdits = (
  held: Held,
  format: Formatter,
  path: string,
  width: number,
): Effect.Effect<Option.Option<ReadonlyArray<Edit>>> =>
  held.code.trim() === ''
    ? Effect.succeed(Option.some([]))
    : format({ code: held.code, path, width }).pipe(
        Effect.map((formatted) =>
          Option.flatMap(restored(formatted.trimEnd(), held.anchors), (after) =>
            editsOf(held.written, after, held.spans),
          ),
        ),
        Effect.catchCause(() => Effect.succeed(Option.none())),
      )

interface Formattable {
  readonly section: LoomSection
  readonly name: string
  readonly format: Formatter
}

const formatterFor = (
  languages: ReadonlyArray<LanguageService>,
  languageId: string,
): Option.Option<Formatter> =>
  pipe(
    Array.findFirst(languages, (language) => language.id === languageId),
    Option.flatMapNullishOr((language) => language.format),
  )

const codeNamed = (module: LoomModule, name: string): Option.Option<Code> =>
  Array.findFirst(module.product?.code ?? [], (code) => code.origin.name === name)

const formattableOf = (
  module: LoomModule,
  languages: ReadonlyArray<LanguageService>,
): ReadonlyArray<Formattable> =>
  pipe(
    module.doc.sections,
    Array.filter(
      (section) =>
        !Array.some(section.code, (weft) => weft.type === 'ArrowWeft' && weft.code !== undefined),
    ),
    Array.map((section) =>
      pipe(
        codeNamed(module, sectionNameOf(section)),
        Option.flatMap((code) =>
          Option.map(formatterFor(languages, code.languageId), (format) => ({
            section,
            name: code.origin.name,
            format,
          })),
        ),
      ),
    ),
    Array.getSomes,
  )

const refsOf = (module: LoomModule, name: string): ReadonlyArray<string> =>
  pipe(
    codeNamed(module, name),
    Option.map((code) =>
      Array.getSomes(
        Array.map(code.fragments, (part) =>
          part.type === 'Fragment'
            ? Option.none()
            : Option.map(
                Option.filter(part.target, (target) => target.path === module.path),
                (target) => target.name,
              ),
        ),
      ),
    ),
    Option.getOrElse((): ReadonlyArray<string> => []),
  )

const membersOf = (
  module: LoomModule,
  name: string,
  seen: ReadonlySet<string> = new Set(),
): ReadonlySet<string> =>
  seen.has(name)
    ? seen
    : Array.reduce(
        refsOf(module, name),
        new Set([...seen, name]) as ReadonlySet<string>,
        (members, ref) => membersOf(module, ref, members),
      )

const fileOf = (module: LoomModule, settings: BuildSettings, name: string): string =>
  pipe(
    Array.findFirst(module.product?.files ?? [], (file) =>
      membersOf(module, file.code.origin.name).has(name),
    ),
    Option.map((file) =>
      outputPath(Option.fromNullishOr(settings.packageRoot), module.path, file.path),
    ),
    Option.getOrElse(() => module.path),
  )

const usesOf = (module: LoomModule, name: string): number =>
  Array.reduce(module.product?.code ?? [], 0, (uses, code) =>
    Array.reduce(refsOf(module, code.origin.name), uses, (count, ref) =>
      ref === name ? count + 1 : count,
    ),
  )

const rootsOf = (module: LoomModule): ReadonlyArray<Code> => {
  const roots = rootNamesAt(new Map([[module.path, module]]), module.path)
  return Array.filter(module.product?.code ?? [], (code) =>
    roots.has(code.origin.name.toLowerCase()),
  )
}

const keepEdges = (before: string, after: string): string =>
  before.trim() === ''
    ? before
    : `${/^\s*/.exec(before)?.[0] ?? ''}${after.trim()}${before.slice(before.trimEnd().length)}`

const verbatimSpans = (text: string, composed: LoomVirtualCode): ReadonlyArray<Span> =>
  pipe(
    composed.mappings,
    Array.filter(
      (mapping) =>
        mapping.kind === 'product' &&
        text.slice(mapping.source.start.offset, mapping.source.start.offset + mapping.genLength) ===
          composed.code.slice(mapping.genStart, mapping.genStart + mapping.genLength),
    ),
    Array.map((mapping) => ({
      genStart: mapping.genStart,
      genLength: mapping.genLength,
      sourceStart: mapping.source.start.offset,
    })),
  )

const placedIn = (
  module: LoomModule,
  settings: BuildSettings,
  languages: ReadonlyArray<LanguageService>,
  name: string,
): Effect.Effect<ReadonlyArray<Edit>> => {
  const blocks = pipe(
    Array.findFirst(module.doc.sections, (section) => sectionNameOf(section) === name),
    Option.map((section) => blocksOf(section, module.text)),
    Option.getOrElse((): ReadonlyArray<Block> => []),
  )
  const within = (start: number, end: number): boolean =>
    Array.some(blocks, (block) => block.start <= start && end <= block.end)
  const root = Array.filter(rootsOf(module), (code) =>
    membersOf(module, code.origin.name).has(name),
  )
  return pipe(
    Array.head(root),
    Option.filter(() => root.length === 1),
    Option.flatMap((code) =>
      Option.map(formatterFor(languages, code.languageId), (format) => ({ code, format })),
    ),
    Option.match({
      onNone: () => Effect.succeed([] as ReadonlyArray<Edit>),
      onSome: ({ code, format }) => {
        const composed = fromProduct(new Map([[module.path, module]]), code.origin)
        const spans = verbatimSpans(module.text, composed)
        const own = Array.filter(spans, (span) =>
          within(span.sourceStart, span.sourceStart + span.genLength),
        )
        const from = Math.min(...Array.map(own, (span) => span.genStart))
        const to = Math.max(...Array.map(own, spanEnd))
        const place = placed(spans, composed.code)
        return format({
          code: composed.code,
          path: fileOf(module, settings, code.origin.name),
          width: settings.width,
        }).pipe(
          Effect.map((formatted) => {
            const placements = pipe(
              diffOf(composed.code, keepEdges(composed.code, formatted)),
              Array.filter((change) => from <= change.start && change.end <= to),
              Array.map((change) => ({ change, edit: place(change) })),
            )
            return Array.some(
              placements,
              ({ change, edit }) => Option.isNone(edit) && !blankChange(composed.code, change),
            )
              ? []
              : Array.filter(Array.getSomes(Array.map(placements, ({ edit }) => edit)), (edit) =>
                  within(edit.start, edit.end),
                )
          }),
          Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<Edit>)),
        )
      },
    }),
  )
}

const composesWhole = (module: LoomModule, root: string): boolean =>
  Array.every(Array.fromIterable(membersOf(module, root)), (name) =>
    Option.exists(codeNamed(module, name), (code) =>
      Array.every(code.fragments, (part) =>
        part.type === 'Fragment'
          ? part.health.status === 'ok'
          : Option.exists(part.target, (target) => target.path === module.path),
      ),
    ),
  )

const brokenRoots = (
  module: LoomModule,
  settings: BuildSettings,
  languages: ReadonlyArray<LanguageService>,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.map(
    Effect.forEach(rootsOf(module), (root) =>
      pipe(
        formatterFor(languages, root.languageId),
        Option.filter(() => composesWhole(module, root.origin.name)),
        Option.match({
          onNone: () => Effect.succeed(Option.none<string>()),
          onSome: (format) =>
            format({
              code: fromProduct(new Map([[module.path, module]]), root.origin).code,
              path: fileOf(module, settings, root.origin.name),
              width: settings.width,
            }).pipe(
              Effect.as(Option.none<string>()),
              Effect.catchCause(() => Effect.succeed(Option.some(root.origin.name))),
            ),
        }),
      ),
    ),
    Array.getSomes,
  )

const textSource = (path: Path, text: string): Source => ({
  read: (at) =>
    at === path
      ? Effect.succeed(text)
      : Effect.fail(
          new ReadError({ path: at, cause: 'the formatter reads only the file it formats' }),
        ),
  list: Option.none(),
})

interface SectionEdits {
  readonly name: string
  readonly edits: ReadonlyArray<Edit>
}

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
          const build = (source: string) =>
            corpus.build(
              textSource(path, source),
              path,
              settings.delims,
              settings.primaryLanguage,
              settings.variables,
            )
          const module = yield* build(text)
          const prose = proseEdits(module.doc, text, settings.delims)
          const sections = formattableOf(module, languages)
          const alone = yield* Effect.forEach(sections, (section) =>
            Effect.map(
              aloneEdits(
                heldOf(section.section, text),
                section.format,
                fileOf(module, settings, section.name),
                settings.width,
              ),
              (edits) => ({ name: section.name, edits }),
            ),
          )
          const formattedAlone = Array.getSomes(
            Array.map(alone, ({ name, edits }) =>
              Option.map(edits, (found) => ({ name, edits: found })),
            ),
          )
          const textWith = (kept: ReadonlyArray<SectionEdits>): string =>
            applyEdits(text, settle([...prose, ...Array.flatMap(kept, ({ edits }) => edits)]))
          const holding = (kept: ReadonlyArray<SectionEdits>) =>
            Effect.gen(function* () {
              const next = yield* build(textWith(kept))
              const broken = yield* brokenRoots(next, settings, languages)
              const lost = new Set(
                Array.flatMap(broken, (root) => Array.fromIterable(membersOf(next, root))),
              )
              return Array.filter(kept, ({ name }) => !lost.has(name))
            })
          const once = yield* holding(formattedAlone)
          const second = once.length === formattedAlone.length ? once : yield* holding(once)
          const kept = second.length === once.length ? once : []
          const settledText = textWith(kept)
          const settledModule = yield* build(settledText)
          const fallback = Array.filter(
            alone,
            ({ name, edits }) => Option.isNone(edits) && usesOf(settledModule, name) === 1,
          )
          const placedEdits = yield* Effect.forEach(fallback, ({ name }) =>
            placedIn(settledModule, settings, languages, name),
          )
          const withFallback = applyEdits(settledText, settle(Array.flatten(placedEdits)))
          const broken = yield* Effect.flatMap(build(withFallback), (next) =>
            brokenRoots(next, settings, languages),
          )
          return broken.length === 0 ? withFallback : settledText
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
