import { Data, Match } from 'effect'
import type { Health, Position, Severity } from '@athrio/loom-ast/LoomNode'

export type MalformedConstruct =
  | 'tag'
  | 'specifier'
  | 'path'
  | 'warpName'
  | 'anchorName'

export type EmptyConstruct =
  | MalformedConstruct
  | 'warpAnnotation'
  | 'warpDefault'

export type LoomFault = Data.TaggedEnum<{
  UnclosedDelimiter: { readonly expected: string }
  EmptyLabel: { readonly construct: EmptyConstruct }
  MalformedLabel: {
    readonly construct: MalformedConstruct
    readonly value: string
  }
  MissingWarpValue: { readonly name: string }
  MissingLanguageWarp: {}
  UnresolvedAnchor: { readonly name: string }
  AmbiguousAnchor: { readonly name: string; readonly count: number }
  CrossLanguageAnchor: {
    readonly name: string
    readonly host: string
    readonly found: string
  }
  CollidingTitles: { readonly name: string }
  SinkCycle: { readonly name: string }
  EmptySink: { readonly directory: string }
  MisplacedSpecifier: { readonly specifier: string }
  SelfRoutingSink: { readonly name: string }
  SinklessChapter: { readonly name: string }
  PointedNotH1: { readonly name: string }
  OrphanedOpening: { readonly name: string }
  DuplicateChapter: { readonly name: string }
  CollidingSinks: { readonly path: string }
}>

export const {
  UnclosedDelimiter,
  EmptyLabel,
  MalformedLabel,
  MissingWarpValue,
  MissingLanguageWarp,
  UnresolvedAnchor,
  AmbiguousAnchor,
  CrossLanguageAnchor,
  CollidingTitles,
  SinkCycle,
  EmptySink,
  MisplacedSpecifier,
  SelfRoutingSink,
  SinklessChapter,
  PointedNotH1,
  OrphanedOpening,
  DuplicateChapter,
  CollidingSinks,
} = Data.taggedEnum<LoomFault>()

type Note = { readonly severity: Severity; readonly message: string }

const error = (message: string): Note => ({ severity: 'error', message })
const warning = (message: string): Note => ({ severity: 'warning', message })

const cap = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1)

const noun: Record<EmptyConstruct, string> = {
  tag: 'tag label',
  specifier: 'specifier label',
  path: 'file path',
  warpName: 'warp name',
  anchorName: 'anchor name',
  warpAnnotation: 'warp annotation',
  warpDefault: 'warp default',
}

const rule: Record<MalformedConstruct, string> = {
  tag: 'may contain only letters, digits, hyphen, and underscore',
  specifier: 'may contain only letters, digits, hyphen, and underscore',
  path: 'may contain only letters, digits, hyphen, underscore, dot, and slash',
  warpName: 'must be a TypeScript identifier',
  anchorName: 'may not contain `]`',
}

export const describe = (fault: LoomFault): Note =>
  Match.value(fault).pipe(
    Match.tag('UnclosedDelimiter', ({ expected }) =>
      error(`expected closing \`${expected}\``),
    ),
    Match.tag('EmptyLabel', ({ construct }) =>
      error(`${cap(noun[construct])} cannot be empty.`),
    ),
    Match.tag('MalformedLabel', ({ construct, value }) =>
      error(`${cap(noun[construct])} ${rule[construct]}; got \`${value}\`.`),
    ),
    Match.tag('MissingWarpValue', ({ name }) =>
      error(`Warp \`${name}\` has no value; a Warp binds a value, as in \`${name} = …\`.`),
    ),
    Match.tag('MissingLanguageWarp', () =>
      warning(
        'No `{{lang: …}}` declaration in the Document Preamble; the primary language is unknown.',
      ),
    ),
    Match.tag('UnresolvedAnchor', ({ name }) =>
      error(
        `Unresolved anchor: no section named \`${name}\`. A tagged section is reachable only through a Warp.`,
      ),
    ),
    Match.tag('AmbiguousAnchor', ({ name, count }) =>
      error(
        `Ambiguous anchor: ${count} sections are named \`${name}\`. A name anchor resolves one local section; rename to disambiguate.`,
      ),
    ),
    Match.tag('CrossLanguageAnchor', ({ name, host, found }) =>
      error(
        `Cross-language transclusion: \`${name}\` is ${found}, but this section composes ${host}. A section composes one language.`,
      ),
    ),
    Match.tag('CollidingTitles', ({ name }) =>
      error(
        `Two sections normalise to the same name \`${name}\`. One name reaches one section; rename one to disambiguate.`,
      ),
    ),
    Match.tag('SinkCycle', ({ name }) =>
      error(
        `Sink cycle: the higher-order sink \`${name}\` reaches itself through its members. A sink tree is acyclic; break the cycle.`,
      ),
    ),
    Match.tag('EmptySink', ({ directory }) =>
      warning(
        `The higher-order sink \`${directory}\` composes nothing; it routes no files. Compose a sink beneath it, or remove it.`,
      ),
    ),
    Match.tag('MisplacedSpecifier', ({ specifier }) =>
      error(
        `Specifier \`${specifier}\` on an anchor. A member names a chapter and never overrides, so an anchor carries no specifier.`,
      ),
    ),
    Match.tag('SelfRoutingSink', ({ name }) =>
      error(
        `A book points the chapter \`${name}\` into its own file. A book routes content, never itself; move the chapter to another loom.`,
      ),
    ),
    Match.tag('SinklessChapter', ({ name }) =>
      warning(
        `The chapter \`${name}\` tangles no file; its higher-order sink places nothing. Give the chapter a file sink, or drop the member.`,
      ),
    ),
    Match.tag('PointedNotH1', ({ name }) =>
      warning(
        `The chapter \`${name}\` opens below a top-level heading. A higher-order sink points at an H1; promote the heading, or point at one.`,
      ),
    ),
    Match.tag('OrphanedOpening', ({ name }) =>
      warning(
        `The first chapter \`${name}\` is not its module's first section, leaving the sections before it unplaced. Open the book's first chapter at the module's first heading.`,
      ),
    ),
    Match.tag('DuplicateChapter', ({ name }) =>
      error(
        `Two higher-order sinks point the chapter \`${name}\`; its files would have two homes. Point it from one sink only.`,
      ),
    ),
    Match.tag('CollidingSinks', ({ path }) =>
      error(
        `Two sinks tangle to \`${path}\`. An output file has one source; give one sink a different path or prefix.`,
      ),
    ),
    Match.exhaustive,
  )

const statusOf = (severity: Severity): Health['status'] =>
  severity === 'info' ? 'ok' : severity

export const faulty = (fault: LoomFault, position: Position): Health => {
  const note = describe(fault)
  return {
    status: statusOf(note.severity),
    diagnostics: [{ message: note.message, position, severity: note.severity }],
  }
}
