import { Array, Data, Match, Option } from 'effect'
import type { Diagnostic, Fix, Health, Position, Severity } from '@athrio/loom-ast/LoomNode'
import { type CopiedFrom, type Opening } from '@athrio/loom-ast/LoomCorpusAst'
import { type LoomKind, type PointingKind, settleKind } from '@athrio/loom-ast/LoomTokens'

export type MalformedConstruct = 'specifier' | 'path' | 'warpName' | 'anchorName'

export type EmptyConstruct = MalformedConstruct | 'warpAnnotation' | 'warpDefault'

export type Sibling = 'section' | 'chapter'

export type Declaration = { readonly at: Position; readonly text: string }

export type BracesOn = 'anchor' | 'box'

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
  UnresolvedTocEntry: { readonly title: string; readonly discussion: boolean }
  UnclosedFence: { readonly fence: string }
  FenceLabelAgainstLanguage: { readonly label: string; readonly language: string }
  StrayFragment: { readonly value: string }
  RepeatedKey: { readonly key: string }
  LabelBesideParameter: { readonly label: string }
  UnknownKey: { readonly key: string; readonly keys: ReadonlyArray<string>; readonly on: BracesOn }
  UnknownKind: {
    readonly kind: string
    readonly kinds: ReadonlyArray<string>
    readonly on: BracesOn
  }
  MissingSymbol: { readonly name: string; readonly section: string; readonly trope?: string }
  KeyOutsideTrope: { readonly key: string }
  StrayTarget: { readonly target: string; readonly at: Position }
  NoSuchFile: {
    readonly name: string
    readonly file: string
    readonly files: ReadonlyArray<string>
    readonly at: Position
  }
  SeveralFiles: { readonly name: string; readonly files: ReadonlyArray<string>; readonly at: Position }
  SectionWithoutFile: {
    readonly name: string
    readonly files: ReadonlyArray<string>
    readonly here: boolean
  }
  UnsettledModule: { readonly name: string; readonly declared: boolean }
  SpecifierUnknown: { readonly name: string; readonly language: string; readonly reason: string }
  TangleBesideSink: { readonly sink: string; readonly specifier: Position }
  TangleWithoutFile: { readonly folder?: string }
  ColonRun: { readonly colons: string }
  NestedBox: {}
  UnclosedBox: {}
  UnnamedBox: { readonly kind: PointingKind }
  ChapterBoxBesideCode: { readonly name: string }
  UnwrittenLoom: { readonly kind: LoomKind; readonly name: string; readonly opening: Opening }
  UnsettledTrope: { readonly name: string; readonly target?: string }
  StaleSummary: {
    readonly of: CopiedFrom
    readonly name: string
    readonly summary: string
    readonly at: Position
  }
  HeadingAgainstCode: {}
  DividerAgainstCode: {}
  FileInDiscussion: {}
  ManifestOutsideTrope: {}
  TropeRefused: { readonly reason: string }
  ConclusionOutsideTopic: {}
  SecondConclusion: {}
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
  StrayTarget,
  NoSuchFile,
  SeveralFiles,
  SectionWithoutFile,
  UnsettledModule,
  SpecifierUnknown,
  TangleBesideSink,
  TangleWithoutFile,
  ColonRun,
  NestedBox,
  UnclosedBox,
  UnnamedBox,
  ChapterBoxBesideCode,
  UnwrittenLoom,
  UnsettledTrope,
  KeyOutsideTrope,
  StaleSummary,
  HeadingAgainstCode,
  DividerAgainstCode,
  FileInDiscussion,
  ManifestOutsideTrope,
  TropeRefused,
  ConclusionOutsideTopic,
  SecondConclusion,
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

const bearer: Record<BracesOn, string> = { anchor: 'an anchor', box: 'a box' }

const pointingWords: Record<PointingKind, { readonly does: string; readonly example: string }> = {
  Chapter: { does: 'points to the chapter its name titles', example: 'Rooms' },
  Discussion: { does: 'points to the discussion its name titles', example: 'Waking' },
  Trope: { does: 'names a trope', example: 'Payments' },
}

const copyWords: Record<CopiedFrom, string> = {
  chapter: 'opening',
  discussion: 'summary',
  section: 'opening',
}

const knownList = (known: ReadonlyArray<string>): string => {
  const marked = Array.map(known, (each) => `\`${each}\``)
  return marked.length > 2
    ? `${Array.join(Array.dropRight(marked, 1), ', ')}, and ${marked[marked.length - 1]}`
    : Array.join(marked, ' and ')
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

const fileList = (files: ReadonlyArray<string>): string =>
  Array.join(
    Array.map(files, (file) => `\`${file}\``),
    ' and ',
  )

const emitted = (files: ReadonlyArray<string>): string =>
  Array.isReadonlyArrayNonEmpty(files) ? `It emits ${fileList(files)}.` : 'It emits no file of its own.'

const composeInstead =
  'Take `Reference` off the anchor and move it out of the import, so it composes the section.'

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
    UnresolvedTocEntry: ({ title, discussion }) =>
      error(
        `Unresolved contents entry: no ${discussion ? 'discussion' : 'chapter'} titled \`${title}\`.`,
      ),
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
    UnknownKey: ({ key, keys, on }) =>
      error(`Unknown key: ${bearer[on]} takes no \`${key}\` key. It takes ${knownList(keys)}.`),
    UnknownKind: ({ kind, kinds, on }) =>
      error(`Unknown kind: ${bearer[on]} takes no kind \`${kind}\`. It takes ${knownList(kinds)}.`),
    MissingSymbol: ({ name, section, trope }) =>
      error(
        trope === undefined
          ? `Missing symbol: \`${section}\` declares no \`${name}\`, which this anchor says it provides.`
          : `Missing symbol: \`${section}\` declares no \`${name}\`, which the trope \`${trope}\` promises.`,
      ),
    StrayTarget: ({ target }) =>
      error(
        `Stray target: \`${target}\` names a file, and only a reference, an anchor of the \`Reference\` kind, names one. This anchor composes code, so remove the target.`,
      ),
    NoSuchFile: ({ name, file, files }) =>
      error(`No such file: \`${name}\` emits no \`${file}\`. ${emitted(files)}`),
    SeveralFiles: ({ name, files }) =>
      error(
        `Several files: \`${name}\` emits ${fileList(files)}. Name the one this reference means in parentheses after its name, as \`(${files[0] ?? ''})\`.`,
      ),
    SectionWithoutFile: ({ name, files, here }) =>
      error(
        Match.value({ here, count: files.length }).pipe(
          Match.when(
            { here: true },
            () =>
              `No file to name: \`${name}\` lands in the file this reference stands in, so no path can name it. ${composeInstead}`,
          ),
          Match.when(
            { count: 0 },
            () =>
              `No file to name: \`${name}\` has no sink and lands in no file, so no path can name it. ${composeInstead}`,
          ),
          Match.orElse(
            () =>
              `No file to name: \`${name}\` has no sink and lands in ${fileList(files)}, so no one path names it. ${composeInstead}`,
          ),
        ),
      ),
    UnsettledModule: ({ name, declared }) =>
      information(
        declared
          ? `To be settled: \`${name}\` emits no file yet, so this reference names no module.`
          : `To be settled: nothing is named \`${name}\` yet, so this reference names no module.`,
      ),
    SpecifierUnknown: ({ name, language, reason }) =>
      error(`Path unwritten: the ${language} package cannot write the path to \`${name}\`. ${reason}`),
    TangleBesideSink: ({ sink }) =>
      error(
        `Two marks for one file: the sink \`${sink}\` already says this section writes a file, so \`{Tangle}\` says it twice. Remove \`{Tangle}\`.`,
      ),
    TangleWithoutFile: ({ folder }) =>
      error(
        `No file for \`{Tangle}\`: it writes the one file the chapter's \`Package\` names, but ${
          folder === undefined ? 'this chapter names no `Package`' : `\`${folder}\` names a folder`
        }. Name the file in brackets instead, as \`[module.ts]\`.`,
      ),
    HeadingAgainstCode: () =>
      warning(
        'This heading sits directly under a line of code, so it ends the code here. If the line belongs to the code, fence the block: write three backticks on the line after its arrow, and three more where the code ends. If it is a heading, leave a blank line above it.',
      ),
    DividerAgainstCode: () =>
      warning(
        'This divider sits directly under a line of code, so it ends the code here. Format the loom to fence the code, which keeps the dashes in it. If the divider divides the chapter, leave a blank line above it.',
      ),
    ManifestOutsideTrope: () =>
      error(
        "Manifest outside a trope: a manifest belongs to a trope's root, a chapter that names its trope with a `Trope:` line, so Loom reads nothing from this section. Name the trope in the frontmatter, or take `{Manifest}` off the heading.",
      ),
    TropeRefused: ({ reason }) =>
      error(`Trope refused: ${reason}, so Loom applies none of what this root declares.`),
    FileInDiscussion: () =>
      error(
        'File in a discussion: a discussion holds no code and writes no file, so this mark means nothing here. Move the code into a chapter, or remove the mark.',
      ),
    ConclusionOutsideTopic: () =>
      error(
        'Conclusion outside a topic: a conclusion closes a topic of a discussion, and a divider opens each topic. Move it under a topic, or make it a note.',
      ),
    SecondConclusion: () =>
      error(
        'Second conclusion: this topic already closes with a conclusion. Merge the two, or open a new topic with a divider.',
      ),
    UnclosedFence: ({ fence }) =>
      error(
        `Unclosed fence: this fenced code runs to the end of the loom, because nothing closes it. Close it with \`${fence}\` at the same column, on a line of its own.`,
      ),
    ColonRun: ({ colons }) =>
      error(
        `Too many colons: a box line starts with three colons, so \`${colons}\` opens and closes nothing. Write \`:::\`.`,
      ),
    NestedBox: () =>
      error(
        'Box inside a box: a box never holds another, so this line opens nothing. Close the open box with `:::` on a line of its own, then open this one.',
      ),
    UnclosedBox: () =>
      error(
        'Unclosed box: this box runs to the end of the loom, because nothing closes it. Close it with `:::` on a line of its own.',
      ),
    UnnamedBox: ({ kind }) =>
      error(
        `${kind} box without a name: a box of the \`${kind}\` kind ${pointingWords[kind].does}, so it needs a name, as in \`::: ${pointingWords[kind].example} {${kind}}\`.`,
      ),
    ChapterBoxBesideCode: ({ name }) =>
      error(
        `Chapter box beside code: this box marks where the chapter \`${name}\` begins, so the code of its section belongs in that chapter. Move the code there, or move the box into a section of its own.`,
      ),
    UnwrittenLoom: ({ kind, name }) =>
      information(
        `To be settled: no ${kind.toLowerCase()} is titled \`${name}\` yet. Open it from this box, and the box's body becomes its opening.`,
      ),
    UnsettledTrope: ({ name, target }) =>
      information(
        target === undefined
          ? `To be settled: the trope \`${name}\` points to no section or chapter yet. Name the one that holds it with \`anchors\`.`
          : `To be settled: the trope \`${name}\` points to \`${target}\`, which names no single section or chapter yet.`,
      ),
    KeyOutsideTrope: ({ key }) =>
      error(
        `Key outside a trope: only a box of the \`Trope\` kind takes the \`${key}\` key, so it means nothing here. Make the box a trope, or take the key off.`,
      ),
    StaleSummary: ({ of, name }) => {
      const copy = copyWords[of]
      return warning(
        `Summary out of step: this box holds a copy of the ${copy} of the ${of} \`${name}\`, and the two differ. Copy the ${of}'s ${copy} into the box, or edit the ${of} to match.`,
      )
    },
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
    Match.tag('StrayTarget', ({ target, at }): ReadonlyArray<Fix> => [
      { title: `Remove \`${target}\``, text: '', at },
    ]),
    Match.tag('NoSuchFile', ({ files, at }) =>
      Array.map(files, (file): Fix => ({ title: `Name \`${file}\``, text: `(${file})`, at })),
    ),
    Match.tag('SeveralFiles', ({ files, at }) =>
      Array.map(files, (file): Fix => ({ title: `Name \`${file}\``, text: `(${file})`, at })),
    ),
    Match.tag('TangleBesideSink', ({ specifier }): ReadonlyArray<Fix> => [
      { title: 'Remove `{Tangle}`', text: '', at: specifier },
    ]),
    Match.tag('ColonRun', (): ReadonlyArray<Fix> => [{ title: 'Write `:::`', text: ':::' }]),
    Match.tag('UnwrittenLoom', ({ kind, name, opening }): ReadonlyArray<Fix> => [
      {
        title: `Open the ${kind.toLowerCase()} \`${name}\``,
        text: opening.text,
        file: opening.file,
      },
    ]),
    Match.tag('StaleSummary', ({ of, name, summary, at }): ReadonlyArray<Fix> => [
      { title: `Copy the ${copyWords[of]} of \`${name}\``, text: summary, at },
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
