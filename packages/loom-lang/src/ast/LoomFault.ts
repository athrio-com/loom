import { Array, Data, Match, Option } from 'effect'
import type { Diagnostic, Fix, Health, Position, Severity } from '@athrio/loom-ast/LoomNode'
import { settleKind } from '@athrio/loom-ast/LoomTokens'

export type MalformedConstruct = 'specifier' | 'path' | 'warpName' | 'anchorName'

export type EmptyConstruct = MalformedConstruct | 'warpAnnotation' | 'warpDefault'

export type Sibling = 'section' | 'chapter'

export type Declaration = { readonly at: Position; readonly text: string }

export type LoomFault = Data.TaggedEnum<{
  UnclosedDelimiter: { readonly expected: string }
  EmptyLabel: { readonly construct: EmptyConstruct }
  MalformedLabel: {
    readonly construct: MalformedConstruct
    readonly value: string
  }
  MissingWarpValue: { readonly name: string }
  UnknownVariable: { readonly name: string }
  UnresolvedAnchor: {
    readonly name: string
    readonly declaration?: Declaration
    readonly settleAt?: Position
  }
  AmbiguousAnchor: {
    readonly name: string
    readonly count: number
    readonly paths: ReadonlyArray<string>
  }
  ChapterWithoutCode: { readonly name: string }
  UnsettledSection: { readonly name: string; readonly declared: boolean }
  SettledLabel: { readonly name: string; readonly label: Position }
  DuplicateName: { readonly name: string; readonly sibling: Sibling; readonly where: string }
  CrossLanguageAnchor: {
    readonly name: string
    readonly host: string
    readonly found: string
  }
  UnresolvedTocEntry: { readonly title: string }
  UnclosedFence: { readonly fence: string }
  FenceLabelAgainstLanguage: { readonly label: string; readonly language: string }
  StrayFragment: { readonly value: string }
  RepeatedKey: { readonly key: string }
  LabelBesideParameter: { readonly label: string }
  UnknownKey: { readonly key: string; readonly keys: ReadonlyArray<string> }
  UnknownKind: { readonly kind: string; readonly kinds: ReadonlyArray<string> }
  MissingSymbol: { readonly name: string; readonly section: string }
  HeadingAgainstCode: {}
}>

export const {
  UnclosedDelimiter,
  EmptyLabel,
  MalformedLabel,
  MissingWarpValue,
  UnknownVariable,
  UnresolvedAnchor,
  AmbiguousAnchor,
  ChapterWithoutCode,
  UnsettledSection,
  SettledLabel,
  DuplicateName,
  CrossLanguageAnchor,
  UnresolvedTocEntry,
  UnclosedFence,
  FenceLabelAgainstLanguage,
  StrayFragment,
  RepeatedKey,
  LabelBesideParameter,
  UnknownKey,
  UnknownKind,
  MissingSymbol,
  HeadingAgainstCode,
} = Data.taggedEnum<LoomFault>()

type Note = { readonly severity: Severity; readonly message: string }

const error = (message: string): Note => ({ severity: 'error', message })

const warning = (message: string): Note => ({ severity: 'warning', message })

const information = (message: string): Note => ({ severity: 'info', message })

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

const noun: Record<EmptyConstruct, string> = {
  specifier: 'specifier label',
  path: 'file path',
  warpName: 'warp name',
  anchorName: 'anchor name',
  warpAnnotation: 'warp annotation',
  warpDefault: 'warp default',
}

const siblingPlace: Record<Sibling, (where: string) => string> = {
  section: (line) => `a section of this loom (line ${line})`,
  chapter: (looms) => `a chapter of this part (${looms})`,
}

const disambiguation = (paths: ReadonlyArray<string>): string =>
  Array.match(paths, {
    onEmpty: () => 'A name anchor resolves to exactly one section; rename to disambiguate.',
    onNonEmpty: (all) =>
      `Write the path to the one you mean: ${Array.join(
        Array.map(all, (path) => `\`${path}\``),
        ' or ',
      )}.`,
  })

const rule: Record<MalformedConstruct, string> = {
  specifier: 'may contain only words of letters, digits, hyphens, and underscores, one space apart',
  path: 'may contain only letters, digits, hyphen, underscore, dot, and slash',
  warpName: 'must be a TypeScript identifier',
  anchorName: 'may not contain `]`',
}

export const describe = (fault: LoomFault): Note =>
  Match.valueTags(fault, {
    UnclosedDelimiter: ({ expected }) => error(`expected closing \`${expected}\``),
    EmptyLabel: ({ construct }) => error(`${cap(noun[construct])} cannot be empty.`),
    MalformedLabel: ({ construct, value }) =>
      error(`${cap(noun[construct])} ${rule[construct]}; got \`${value}\`.`),
    MissingWarpValue: ({ name }) =>
      error(`Warp \`${name}\` has no value; a Warp binds a value, as in \`${name} = …\`.`),
    UnknownVariable: ({ name }) =>
      error(
        `Unknown variable: no workspace variable named \`${name}\`. Declare it under \`variables:\` in the configuration.`,
      ),
    UnresolvedAnchor: ({ name }) => error(`Unresolved anchor: no section named \`${name}\`.`),
    AmbiguousAnchor: ({ name, count, paths }) =>
      error(`Ambiguous anchor: ${count} sections are named \`${name}\`. ${disambiguation(paths)}`),
    ChapterWithoutCode: ({ name }) =>
      warning(
        `Chapter \`${name}\` opens with a section that holds no code, so this anchor composes nothing.`,
      ),
    UnsettledSection: ({ name, declared }) =>
      information(
        declared
          ? `To be settled: \`${name}\` holds no code yet, so this anchor composes nothing.`
          : `To be settled: no section is named \`${name}\` yet, so this anchor composes nothing.`,
      ),
    SettledLabel: ({ name }) =>
      information(
        `Settled: \`${name}\` holds code now, so its \`{To be settled}\` label has nothing left to say.`,
      ),
    DuplicateName: ({ name, sibling, where }) =>
      error(`Duplicate name: \`${name}\` is already ${siblingPlace[sibling](where)}. Rename one.`),
    CrossLanguageAnchor: ({ name, host, found }) =>
      error(
        `Cross-language transclusion: \`${name}\` is ${found}, but this section composes ${host}. A section composes one language.`,
      ),
    UnresolvedTocEntry: ({ title }) =>
      error(`Unresolved contents entry: no chapter titled \`${title}\`.`),
    StrayFragment: ({ value }) =>
      error(
        `Unexpected \`${value}\`: this line has no place for it, so Loom would ignore it. A heading carries one specifier and one sink.`,
      ),
    RepeatedKey: ({ key }) =>
      error(
        `Repeated key: \`${key}\` appears twice in these braces, so nothing tells which value is meant. Keep one.`,
      ),
    LabelBesideParameter: ({ label }) =>
      error(
        `Label beside parameters: \`${label}\` stands alone only in braces that hold nothing else. Beside parameters, write it in full, as \`kind="${label}"\`.`,
      ),
    UnknownKey: ({ key, keys }) =>
      error(
        `Unknown key: an anchor takes no \`${key}\` key. It takes ${Array.join(
          Array.map(keys, (known) => `\`${known}\``),
          ' and ',
        )}.`,
      ),
    UnknownKind: ({ kind, kinds }) =>
      error(
        `Unknown kind: an anchor takes no kind \`${kind}\`. It takes ${Array.join(
          Array.map(kinds, (known) => `\`${known}\``),
          ' and ',
        )}.`,
      ),
    MissingSymbol: ({ name, section }) =>
      error(
        `Missing symbol: \`${section}\` declares no \`${name}\`, which this anchor says it provides.`,
      ),
    HeadingAgainstCode: () =>
      warning(
        'This heading sits directly under a line of code, so it ends the code here. If the line belongs to the code, fence the block: write three backticks on the line after its arrow, and three more where the code ends. If it is a heading, leave a blank line above it.',
      ),
    UnclosedFence: ({ fence }) =>
      error(
        `Unclosed fence: this fenced code runs to the end of the loom, because nothing closes it. Close it with \`${fence}\` at the same column, on a line of its own.`,
      ),
    FenceLabelAgainstLanguage: ({ label, language }) =>
      error(
        `Fence label against the language: this fence is labelled \`${label}\`, but its section's code is ${language}. Label it \`${language}\`, or leave the label off.`,
      ),
  })

const statusOf = (severity: Severity): Health['status'] => (severity === 'info' ? 'ok' : severity)

export const fixesOf = (fault: LoomFault): ReadonlyArray<Fix> =>
  Match.value(fault).pipe(
    Match.tag('AmbiguousAnchor', ({ paths }) =>
      Array.map(paths, (path): Fix => ({ title: `Write the path \`${path}\``, text: path })),
    ),
    Match.tag('UnresolvedAnchor', ({ name, declaration, settleAt }) => [
      ...Option.toArray(
        Option.map(Option.fromNullishOr(declaration), (declared): Fix => ({
          title: `Declare the section \`${name}\``,
          text: declared.text,
          at: declared.at,
        })),
      ),
      ...Option.toArray(
        Option.map(Option.fromNullishOr(settleAt), (at): Fix => ({
          title: `Mark \`${name}\` to be settled`,
          text: `{${settleKind}}`,
          at,
        })),
      ),
    ]),
    Match.tag('SettledLabel', ({ label }): ReadonlyArray<Fix> => [
      { title: 'Remove the `{To be settled}` label', text: '', at: label },
    ]),
    Match.tag('LabelBesideParameter', ({ label }): ReadonlyArray<Fix> => [
      { title: `Write \`${label}\` in full`, text: `kind="${label}"` },
    ]),
    Match.orElse((): ReadonlyArray<Fix> => []),
  )

const diagnosticOf = (note: Note, position: Position, fixes: ReadonlyArray<Fix>): Diagnostic =>
  Array.isReadonlyArrayNonEmpty(fixes)
    ? { message: note.message, position, severity: note.severity, fixes }
    : { message: note.message, position, severity: note.severity }

export const faultAt = (fault: LoomFault, position: Position): Diagnostic =>
  diagnosticOf(describe(fault), position, fixesOf(fault))

export const faulty = (fault: LoomFault, position: Position): Health => ({
  status: statusOf(describe(fault).severity),
  diagnostics: [faultAt(fault, position)],
})
