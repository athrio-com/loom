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
  CompositionCycle: { readonly loop: ReadonlyArray<string> }
  UnsettledSection: { readonly name: string; readonly declared: boolean }
  SettledLabel: { readonly name: string; readonly label: Position }
  DuplicateName: { readonly name: string; readonly sibling: Sibling; readonly where: string }
  CrossLanguageAnchor: {
    readonly name: string
    readonly host: string
    readonly found: string
  }
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
  CodeInProse: {}
  ManifestOutsideTrope: {}
  TropeRefused: { readonly reason: string }
  UnrootedTrope: { readonly trope: string }
  CircularRoots: { readonly loop: ReadonlyArray<string> }
  EntriesOffRoot: {}
  UnknownEntry: { readonly name: string }
  ForeignEntry: { readonly name: string; readonly trope: string }
  PrivateEntry: { readonly name: string; readonly trope: string }
  UnsettledMember: { readonly trope: string }
  UnusedSection: { readonly name: string }
  ReachingInside: {
    readonly trope: string
    readonly chapter: string
    readonly entries: ReadonlyArray<string>
  }
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
  CompositionCycle,
  UnsettledSection,
  SettledLabel,
  DuplicateName,
  CrossLanguageAnchor,
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
  CodeInProse,
  ManifestOutsideTrope,
  TropeRefused,
  UnrootedTrope,
  CircularRoots,
  EntriesOffRoot,
  UnknownEntry,
  ForeignEntry,
  PrivateEntry,
  UnsettledMember,
  UnusedSection,
  ReachingInside,
  ConclusionOutsideTopic,
  SecondConclusion,
} = Data.taggedEnum<LoomFault>()

type Note = { readonly severity: Severity; readonly message: string }

const error = (message: string): Note => ({ severity: 'error', message })

const warning = (message: string): Note => ({ severity: 'warning', message })

const information = (message: string): Note => ({ severity: 'info', message })

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

const withArticle = (word: string): string => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`)

const empty: Record<EmptyConstruct, string> = {
  specifier: 'These braces are empty. Write a label in them, or remove them.',
  path: 'This sink names no file. Write a file name in its brackets, or remove them.',
  warpName: 'This warp has no name. Write one before its `=`.',
  anchorName: 'This anchor names nothing. Write the name of a section or chapter in its brackets.',
  warpAnnotation: 'This warp has an empty type. Write a type after its colon, or remove the colon.',
  warpDefault: 'This warp has no value. Write one after its `=`.',
}

const noun: Record<MalformedConstruct, string> = {
  specifier: 'label',
  path: 'file path',
  warpName: 'warp name',
  anchorName: 'anchor name',
}

const rule: Record<MalformedConstruct, string> = {
  specifier: 'may contain only words of letters, digits, hyphens, and underscores, one space apart',
  path: 'may contain only letters, digits, hyphen, underscore, dot, and slash',
  warpName: 'must be a TypeScript identifier',
  anchorName: 'may not contain `]`',
}

const bearer: Record<BracesOn, string> = { anchor: 'an anchor', box: 'a box' }

const exampleName: Record<PointingKind, string> = {
  Chapter: 'Rooms',
  Discussion: 'Waking',
  Trope: 'Payments',
}

const copyWords: Record<CopiedFrom, string> = {
  chapter: 'opening',
  discussion: 'summary',
  section: 'opening',
}

const loopLine = (loop: ReadonlyArray<string>): string =>
  Array.join(
    Array.map(loop, (title) => `\`${title}\``),
    ' → ',
  )

const elsewhere = (loop: ReadonlyArray<string>): string =>
  Array.join(
    Array.map(Array.dropRight(Array.drop(loop, 1), 1), (title) => `\`${title}\``),
    ' or ',
  )

const orList = (names: ReadonlyArray<string>): string =>
  Array.join(
    Array.map(names, (name) => `\`${name}\``),
    ' or ',
  )

const knownList = (known: ReadonlyArray<string>): string => {
  const marked = Array.map(known, (each) => `\`${each}\``)
  return marked.length > 2
    ? `${Array.join(Array.dropRight(marked, 1), ', ')}, and ${marked[marked.length - 1]}`
    : Array.join(marked, ' and ')
}

const siblingPlace: Record<Sibling, (where: string) => string> = {
  section: (line) => `Another section of this loom, on line ${line},`,
  chapter: (looms) => `Another chapter of this part, in ${looms},`,
}

const disambiguation = (paths: ReadonlyArray<string>): string =>
  Array.match(paths, {
    onEmpty: () => 'Rename one of them.',
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

export const describe = (fault: LoomFault): Note =>
  Match.valueTags(fault, {
    UnclosedDelimiter: ({ expected }) =>
      error(`This is never closed. Add \`${expected}\` on the same line.`),
    EmptyLabel: ({ construct }) => error(empty[construct]),
    MalformedLabel: ({ construct, value }) =>
      error(
        `\`${value}\` is not a valid ${noun[construct]}. ${cap(withArticle(noun[construct]))} ${rule[construct]}.`,
      ),
    MissingWarpValue: ({ name }) =>
      error(`Warp \`${name}\` has no value. Give it one, as in \`${name} = …\`.`),
    UnknownVariable: ({ name }) =>
      error(
        `No variable is called \`${name}\`. Declare it under \`variables:\` in \`.loom/config.yaml\`.`,
      ),
    UnresolvedAnchor: ({ name }) =>
      error(
        `No section or chapter is called \`${name}\`. Write one, or label this anchor \`{To be settled}\`.`,
      ),
    AmbiguousAnchor: ({ name, count, paths }) =>
      error(`\`${name}\` names ${count} sections. ${disambiguation(paths)}`),
    ChapterWithoutCode: ({ name }) =>
      warning(
        `Chapter \`${name}\` holds no code in its opening section, so this anchor composes nothing. Name the section that holds the code instead.`,
      ),
    CompositionCycle: ({ loop }) =>
      error(
        loop.length > 2
          ? `Circular composition: ${loopLine(loop)}. Remove this anchor, or the one in ${elsewhere(loop)}.`
          : `Circular composition: \`${loop[0]}\` composes itself. Remove this anchor.`,
      ),
    UnsettledSection: ({ name, declared }) =>
      information(
        declared
          ? `\`${name}\` holds no code yet, so this anchor composes nothing.`
          : `No section is called \`${name}\` yet, so this anchor composes nothing.`,
      ),
    SettledLabel: ({ name }) =>
      information(`\`${name}\` holds code now. Remove the \`{To be settled}\` label.`),
    DuplicateName: ({ name, sibling, where }) =>
      error(`${siblingPlace[sibling](where)} is called \`${name}\` too. Rename one of them.`),
    CrossLanguageAnchor: ({ name, host, found }) =>
      error(
        `\`${name}\` holds ${found} code, but this section holds ${host}. A section composes code of its own language only.`,
      ),
    StrayFragment: ({ value }) =>
      error(`This line has no place for \`${value}\`, so Loom would ignore it. Remove it.`),
    RepeatedKey: ({ key }) => error(`\`${key}\` is written twice in these braces. Keep one.`),
    LabelBesideParameter: ({ label }) =>
      error(
        `A label stands alone only in braces that hold nothing else. Write it in full here, as \`kind="${label}"\`.`,
      ),
    UnknownKey: ({ key, keys, on }) =>
      error(`${cap(bearer[on])} takes no \`${key}\` key. It takes ${knownList(keys)}.`),
    UnknownKind: ({ kind, kinds, on }) =>
      error(`${cap(bearer[on])} takes no \`${kind}\` kind. It takes ${knownList(kinds)}.`),
    MissingSymbol: ({ name, section, trope }) =>
      error(
        trope === undefined
          ? `\`${section}\` declares no \`${name}\`, though this anchor lists it in \`provides\`. Declare it in \`${section}\`, or take it out of \`provides\`.`
          : `\`${section}\` declares no \`${name}\`, though the \`${trope}\` trope promises it. Declare it in \`${section}\`, or take it out of \`provides\` on the trope box.`,
      ),
    StrayTarget: ({ target }) =>
      error(`Only a reference names a file, and this anchor composes code. Remove \`${target}\`.`),
    NoSuchFile: ({ name, file, files }) =>
      error(`\`${name}\` emits no \`${file}\`. ${emitted(files)}`),
    SeveralFiles: ({ name, files }) =>
      error(
        `\`${name}\` emits ${fileList(files)}. Name the one you mean in parentheses after its name, as \`(${files[0] ?? ''})\`.`,
      ),
    SectionWithoutFile: ({ name, files, here }) =>
      error(
        Match.value({ here, count: files.length }).pipe(
          Match.when(
            { here: true },
            () =>
              `\`${name}\` lands in the file this reference stands in, so no path can name it. ${composeInstead}`,
          ),
          Match.when(
            { count: 0 },
            () =>
              `\`${name}\` has no sink and lands in no file, so no path can name it. ${composeInstead}`,
          ),
          Match.orElse(
            () =>
              `\`${name}\` has no sink and lands in ${fileList(files)}, so no one path names it. ${composeInstead}`,
          ),
        ),
      ),
    UnsettledModule: ({ name, declared }) =>
      information(
        declared
          ? `\`${name}\` emits no file yet, so this reference names no module.`
          : `Nothing is called \`${name}\` yet, so this reference names no module.`,
      ),
    SpecifierUnknown: ({ name, language, reason }) =>
      error(`The ${language} package can't write the path to \`${name}\`. ${reason}`),
    TangleBesideSink: ({ sink }) =>
      error(
        `The sink \`${sink}\` already names the file this section writes. Remove \`{Tangle}\`.`,
      ),
    TangleWithoutFile: ({ folder }) =>
      error(
        `\`{Tangle}\` writes the file the chapter's \`Package\` names, but ${
          folder === undefined ? 'this chapter names no `Package`' : `\`${folder}\` is a folder`
        }. Name the file in brackets instead, as \`[module.ts]\`.`,
      ),
    HeadingAgainstCode: () =>
      warning(
        'This heading ends the code above it. If the line is a comment in the code, fence the block: three backticks on the line after its arrow, and three where the code ends. If it is a heading, leave a blank line above it.',
      ),
    DividerAgainstCode: () =>
      warning(
        'This divider ends the code above it. If the dashes belong to the code, format the loom to fence it. If the divider divides the chapter, leave a blank line above it.',
      ),
    ManifestOutsideTrope: () => error('Only a trope chapter can hold a manifest.'),
    TropeRefused: ({ reason }) => error(`Loom ignores this trope: ${reason}.`),
    UnrootedTrope: ({ trope }) => information(`No trope chapter is called \`${trope}\`.`),
    CircularRoots: ({ loop }) =>
      error(
        `Circular roots: ${loopLine(loop)}. Remove the \`Rooted in:\` line here, or the one in ${elsewhere(loop)}.`,
      ),
    EntriesOffRoot: () => error('Only a trope chapter can list entries.'),
    UnknownEntry: ({ name }) => error(`No chapter is called \`${name}\`.`),
    ForeignEntry: ({ name, trope }) =>
      error(`Chapter \`${name}\` belongs to the \`${trope}\` trope, not to this one.`),
    PrivateEntry: ({ name, trope }) =>
      error(
        `Chapter \`${name}\` is private to the \`${trope}\` trope, so this trope can't list it.`,
      ),
    UnsettledMember: ({ trope }) =>
      information(
        `Undeclared relation to the \`${trope}\` trope. Add \`Rooted in: ${trope}\` to its frontmatter.`,
      ),
    ReachingInside: ({ trope, chapter, entries }) =>
      error(
        Array.isReadonlyArrayNonEmpty(entries)
          ? `Chapter \`${chapter}\` is private to the \`${trope}\` trope. Use it via ${orList(entries)} instead.`
          : `Chapter \`${chapter}\` is private to the \`${trope}\` trope, which has no entries yet.`,
      ),
    UnusedSection: ({ name }) => warning(`\`${name}\` is never used across the corpus.`),
    FileInDiscussion: () =>
      error(
        'A discussion writes no file, so it takes no sink or `{Tangle}`. Remove it, or move the section into a chapter.',
      ),
    CodeInProse: () =>
      error(
        'Prose holds no code. Quote this code in a fence, or name its language on the heading, as in `{TypeScript}`.',
      ),
    ConclusionOutsideTopic: () =>
      error(
        'Only a topic holds a conclusion, and a divider opens each topic. Move this one below a divider, or make it a note.',
      ),
    SecondConclusion: () =>
      error(
        'This topic already has a conclusion. Merge the two, or open a new topic with a divider.',
      ),
    UnclosedFence: ({ fence }) =>
      error(
        `Nothing closes this fence, so its code runs to the end of the loom. Close it with \`${fence}\` on a line of its own, at the same column.`,
      ),
    ColonRun: ({ colons }) =>
      error(`A box line starts with three colons, not ${colons.length}. Write \`:::\`.`),
    NestedBox: () =>
      error(
        'A box never holds another box. Close the open one with `:::` on a line of its own, then open this one.',
      ),
    UnclosedBox: () =>
      error(
        'Nothing closes this box, so it runs to the end of the loom. Close it with `:::` on a line of its own.',
      ),
    UnnamedBox: ({ kind }) =>
      error(
        `This box needs a name. Write it before \`{${kind}}\`, as in \`::: ${exampleName[kind]} {${kind}}\`.`,
      ),
    ChapterBoxBesideCode: ({ name }) =>
      error(
        `This box begins the chapter \`${name}\`, so no code belongs in its section. Move the code into \`${name}\`, or give the box a section of its own.`,
      ),
    UnwrittenLoom: ({ kind, name }) =>
      information(
        `No ${kind.toLowerCase()} is titled \`${name}\` yet. Open it from this box, and the box's body becomes its opening.`,
      ),
    UnsettledTrope: ({ name, target }) =>
      information(
        target === undefined
          ? `The \`${name}\` trope points nowhere yet. Name the section or chapter that holds it with \`anchors\`.`
          : `No single section or chapter is called \`${target}\`, so the \`${name}\` trope points nowhere yet.`,
      ),
    KeyOutsideTrope: ({ key }) => error(`Only a trope box takes the \`${key}\` key.`),
    StaleSummary: ({ of, name }) => {
      const copy = copyWords[of]
      return warning(
        `This box no longer matches the ${copy} of the ${of} \`${name}\`. Copy that ${copy} into it, or run \`loom refresh\`.`,
      )
    },
    FenceLabelAgainstLanguage: ({ label, language }) =>
      error(
        `This fence is labelled \`${label}\`, but its section's code is ${language}. Label it \`${language}\`, or leave the label off.`,
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
