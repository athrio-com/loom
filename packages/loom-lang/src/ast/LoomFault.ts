import { Data, Match } from 'effect'
import type { Health, Position, Severity } from '@athrio/loom-ast/LoomNode'

export type MalformedConstruct =
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
  UnknownVariable: { readonly name: string }
  UnresolvedAnchor: { readonly name: string }
  AmbiguousAnchor: { readonly name: string; readonly count: number }
  CrossLanguageAnchor: {
    readonly name: string
    readonly host: string
    readonly found: string
  }
  UnresolvedTocEntry: { readonly title: string }
}>

export const {
  UnclosedDelimiter,
  EmptyLabel,
  MalformedLabel,
  MissingWarpValue,
  UnknownVariable,
  UnresolvedAnchor,
  AmbiguousAnchor,
  CrossLanguageAnchor,
  UnresolvedTocEntry,
} = Data.taggedEnum<LoomFault>()

type Note = { readonly severity: Severity; readonly message: string }

const error = (message: string): Note => ({ severity: 'error', message })

const cap = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1)

const noun: Record<EmptyConstruct, string> = {
  specifier: 'specifier label',
  path: 'file path',
  warpName: 'warp name',
  anchorName: 'anchor name',
  warpAnnotation: 'warp annotation',
  warpDefault: 'warp default',
}

const rule: Record<MalformedConstruct, string> = {
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
    Match.tag('UnknownVariable', ({ name }) =>
      error(
        `Unknown variable: no workspace variable named \`${name}\`. Declare it under \`variables:\` in the configuration.`,
      ),
    ),
    Match.tag('UnresolvedAnchor', ({ name }) =>
      error(`Unresolved anchor: no section named \`${name}\`.`),
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
    Match.tag('UnresolvedTocEntry', ({ title }) =>
      error(`Unresolved contents entry: no chapter titled \`${title}\`.`),
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
