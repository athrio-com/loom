import { Cause, Data, Match, Option } from 'effect'
import { defaultAnchorDelims, type InvalidAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import type {
  NotAVariableName,
  SettingsNotWritten,
  SettingsUnread,
} from '@athrio/loom-config/LoomConfig'
import type {
  PackageMissing,
  PackageNotLoaded,
  PackageStale,
  PackageWithoutService,
} from '@athrio/loom-lang-services/LanguageLoader'
import type { ServiceError } from '@athrio/loom-lang-services/LanguageService'
import type { StoreError } from '@athrio/loom-lang-services/LoomStore'
import type { ReadError } from '#ast/LoomCorpusAstBuilder'
import type { TangleError } from '../LoomCompiler'
import type {
  BookExists,
  EditBreaksLoom,
  LoomExists,
  NoConfiguration,
  NoSuchBook,
  NoSuchNote,
  NoSuchPart,
  NoSuchSection,
  NotADiscussion,
  NotInPart,
  NotOfKind,
  OpensABook,
  OpensTheLoom,
  PartExists,
  PartNameIsNumber,
  SectionExists,
  TitleTaken,
  UnfitName,
  UnfitParameter,
  UnfitText,
} from '../EditBuilder'
import type { NoSuchLoom } from '../OutlineBuilder'
import type { ClassicTypeScriptMissing, RequestUnread, TypeScriptNotFetched } from '../LoomServer'
import type { NotRemoved, NotWritten } from '../LoomTangler'
import type { TropeRefused } from '../TropePackages'
import type { RelationsNotKept, StorageTakesNoWrite } from '../WorkspaceSource'

export type Problem = { readonly summary: string; readonly detail: string }

export const problem = (summary: string, detail = ''): Problem => ({ summary, detail })

const closed = (words: string): string => (/(^|[.!?])$/.test(words) ? words : `${words}.`)

const firstParagraph = (text: string): string =>
  (text.split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').trim().replace(/:$/, '')

const saidBy = (cause: unknown): string => {
  if (isWordedBy(failureWording)(cause)) return lineOf(describe(cause))
  return cause instanceof Error ? cause.message || cause.name : String(cause)
}

export const reasonOf = (cause: unknown): string => closed(firstParagraph(saidBy(cause)))

export type Wording<Failure extends { readonly _tag: string }> = {
  readonly [Tag in Failure['_tag']]: (failure: Extract<Failure, { readonly _tag: Tag }>) => Problem
}

export type ReadingFailure = ReadError | InvalidAnchorDelims

const delimiterAdvice = `Set \`anchor\` in \`.loom/config.yaml\` to a pair that Loom does not use and your code never writes, such as \`${defaultAnchorDelims.open}\` and \`${defaultAnchorDelims.close}\`.`

const readingWording: Wording<ReadingFailure> = {
  ReadError: ({ path, cause }) => problem(`Loom could not read ${path}.`, reasonOf(cause)),
  EmptyAnchorDelims: () => problem('An anchor delimiter cannot be empty.', delimiterAdvice),
  IdenticalAnchorDelims: ({ delim }) =>
    problem(`An anchor cannot open and close with the same \`${delim}\`.`, delimiterAdvice),
  WhitespaceAnchorDelims: () =>
    problem('An anchor delimiter cannot hold white space.', delimiterAdvice),
  ReservedAnchorDelims: ({ marker }) =>
    problem(`An anchor cannot open with \`${marker}\`, which Loom already uses.`, delimiterAdvice),
}

export type WritingFailure = NotWritten | NotRemoved | SettingsNotWritten

const writingWording: Wording<WritingFailure> = {
  NotWritten: ({ path, cause }) => problem(`Loom could not write ${path}.`, reasonOf(cause)),
  NotRemoved: ({ path, cause }) => problem(`Loom could not remove ${path}.`, reasonOf(cause)),
  SettingsNotWritten: ({ path, cause }) =>
    problem(`Loom could not write ${path}.`, reasonOf(cause)),
}

export type TanglingFailure = TangleError

export const refusedBy = ({ failures }: TangleError): ReadonlyArray<string> =>
  failures.flatMap(({ path, diagnostics }) =>
    diagnostics.map(({ position, message }) => `${path}:${position.start.line}: ${message}`),
  )

const howMany = (count: number): string => (count === 1 ? 'one problem' : `${count} problems`)

const tanglingWording: Wording<TanglingFailure> = {
  TangleError: (refused) =>
    problem(
      `Loom did not tangle ${refused.entry}.`,
      `Its looms hold ${howMany(refusedBy(refused).length)}.`,
    ),
}

export type PackageFailure =
  StoreError | TypeScriptNotFetched | ClassicTypeScriptMissing | ServiceError

const packageWording: Wording<PackageFailure> = {
  StoreError: ({ packageName, cause }) =>
    problem(`Loom could not install ${packageName}.`, reasonOf(cause)),
  TypeScriptNotFetched: ({ version, folder, cause }) =>
    problem(`Loom could not fetch TypeScript ${version} into ${folder}.`, reasonOf(cause)),
  ClassicTypeScriptMissing: ({ folder, tsdk, cause }) =>
    Option.match(tsdk, {
      onNone: () =>
        problem(
          `Loom found no TypeScript 6 for ${folder}, in the project or beside Loom.`,
          'Install it in the project with `npm install -D typescript@6`.',
        ),
      onSome: (found) => problem(`The TypeScript in ${found} did not load.`, reasonOf(cause)),
    }),
  ServiceError: ({ service, reason }) =>
    problem(`The ${service} language service failed.`, reasonOf(reason)),
}

export type KeepingFailure = RelationsNotKept | StorageTakesNoWrite

const keepingWording: Wording<KeepingFailure> = {
  RelationsNotKept: ({ workspace, cause }) =>
    problem(`Loom could not keep the relations of ${workspace}.`, reasonOf(cause)),
  StorageTakesNoWrite: ({ workspace }) =>
    problem(`Loom could not keep the relations of ${workspace}.`, 'Remote storage takes no write.'),
}

export type AskingFailure =
  | RequestUnread
  | NoSuchLoom
  | LoomExists
  | NoSuchBook
  | BookExists
  | NoSuchPart
  | PartExists
  | PartNameIsNumber
  | TitleTaken
  | NotInPart
  | NotOfKind
  | NoSuchSection
  | SectionExists
  | OpensTheLoom
  | NoSuchNote
  | NotADiscussion
  | UnfitName
  | UnfitText
  | UnfitParameter
  | OpensABook
  | NoConfiguration
  | NotAVariableName
  | EditBreaksLoom

const bookWords = (book: string): string => (book === '' ? 'the default book' : `the book ${book}`)

const askingWording: Wording<AskingFailure> = {
  RequestUnread: ({ request, cause }) =>
    problem(`Loom could not read the parameters of ${request}.`, reasonOf(cause)),
  NoSuchLoom: ({ path }) =>
    problem(
      `The workspace holds no loom at ${path}.`,
      'Name a loom the workspace holds, or make it first.',
    ),
  LoomExists: ({ path }) =>
    problem(`A loom is already kept at ${path}.`, 'Choose another place for the new loom.'),
  NoSuchBook: ({ book }) =>
    problem(
      `No loom names the book ${book}.`,
      'Make the book first, or name a book the workspace holds.',
    ),
  BookExists: ({ book }) =>
    problem(`A loom already opens the book ${book}.`, 'Choose another name for the book.'),
  NoSuchPart: ({ book, part }) =>
    problem(
      `No part ${part} stands in ${bookWords(book)}.`,
      'Name a part by its number or its name, as the contents list it.',
    ),
  PartExists: ({ book, part }) =>
    problem(
      `A part named ${part} already stands in ${bookWords(book)}.`,
      'Choose another name for the part.',
    ),
  PartNameIsNumber: ({ name }) =>
    problem(
      `The name ${name} reads as a part's number.`,
      'Give the part a name that is no Roman numeral.',
    ),
  TitleTaken: ({ title, book, part }) =>
    problem(
      `A loom titled ${title} already stands in part ${part} of ${bookWords(book)}.`,
      'Choose another title, since two looms of one part cannot share one.',
    ),
  NotInPart: ({ path }) =>
    problem(
      `No loom of that part stands at ${path}.`,
      'Name a loom of the part to follow, or leave it out to place the loom last.',
    ),
  NotOfKind: ({ path, kind }) =>
    problem(
      `The loom ${path} is no ${kind}, and each kind of loom is numbered apart.`,
      `Name a ${kind} of the part to follow, or leave it out to place the loom last.`,
    ),
  NoSuchSection: ({ path, section }) =>
    problem(
      `The loom ${path} holds no section named ${section}.`,
      'Name a section by its heading, as the outline gives it.',
    ),
  SectionExists: ({ path, section }) =>
    problem(
      `The loom ${path} already holds a section named ${section}.`,
      'Choose another name, since two sections of one loom cannot share one.',
    ),
  OpensTheLoom: ({ path, section }) =>
    problem(
      `The section ${section} opens the loom ${path} and carries its title.`,
      'Remove or move the loom itself, or retitle it.',
    ),
  NoSuchNote: ({ path, section }) =>
    problem(
      `The section ${section} of ${path} holds no note with those words.`,
      'Name the note by its whole text, as the outline gives it.',
    ),
  NotADiscussion: ({ path }) =>
    problem(`The loom ${path} is no discussion.`, 'Open topics and add messages in a discussion.'),
  UnfitName: ({ name }) =>
    problem(
      `The name ${JSON.stringify(name)} cannot stand in a loom.`,
      'Give a name that holds words, on one line.',
    ),
  UnfitText: ({ line }) =>
    problem(
      `The line ${JSON.stringify(line)} would read as Loom's syntax, not as words.`,
      'Reword it so it does not open as a heading, an arrow, a tilde, a divider, or a box does, and close any fence it opens.',
    ),
  UnfitParameter: ({ key }) =>
    problem(
      `The parameter ${JSON.stringify(key)} cannot stand in braces.`,
      'Name it with a letter or an underscore followed by letters, digits, hyphens, and underscores, keep each of its values on one line, and give a kind or a language in its own field.',
    ),
  OpensABook: ({ path }) =>
    problem(
      `The loom ${path} opens a book, so it stands in no part.`,
      'Move the chapters of the book instead.',
    ),
  NoConfiguration: ({ workspace }) =>
    problem(
      `The workspace ${workspace} has no configuration.`,
      'Give it a configuration in `.loom/config.yaml` first.',
    ),
  NotAVariableName: ({ name }) =>
    problem(
      `The name \`${name}\` is not a variable name.`,
      'A name holds letters, digits and underscores, and does not open on a digit.',
    ),
  EditBreaksLoom: ({ path, problems }) =>
    problem(
      `The edit would leave ${path} with ${howMany(problems.length)} it does not hold now.`,
      closed(problems.join(' ')),
    ),
}

export type Warning =
  | SettingsUnread
  | PackageStale
  | PackageMissing
  | PackageWithoutService
  | PackageNotLoaded
  | TropeRefused

const warningWording: Wording<Warning> = {
  SettingsUnread: ({ path, cause }) =>
    problem(
      `Loom could not read ${path}.`,
      `${reasonOf(cause)} Loom goes on with its own defaults.`,
    ),
  PackageStale: ({ language, packageName, held, wanted }) =>
    problem(
      `The store holds ${packageName} at ${held}, and this Loom is ${wanted}.`,
      `Run \`loom update ${language}\` to bring it along.`,
    ),
  PackageMissing: ({ language, packageName }) =>
    problem(
      `The language ${language} is activated, and ${packageName} is not installed.`,
      `Run \`loom update ${language}\` to install it.`,
    ),
  PackageWithoutService: ({ language, packageName }) =>
    problem(`The package ${packageName} exports no language service for ${language}.`),
  PackageNotLoaded: ({ packageName, cause }) =>
    problem(`The package ${packageName} could not be loaded.`, reasonOf(cause)),
  TropeRefused: ({ module, reason }) =>
    problem(`Loom refuses the installed trope in ${module}.`, reasonOf(reason)),
}

const isWordedBy =
  <Failure extends { readonly _tag: string }>(wording: Wording<Failure>) =>
  (value: unknown): value is Failure =>
    typeof value === 'object' &&
    value !== null &&
    '_tag' in value &&
    typeof value._tag === 'string' &&
    Object.keys(wording).includes(value._tag)

export const failureIn =
  <Failure extends { readonly _tag: string }>(wording: Wording<Failure>) =>
  (message: unknown): Option.Option<Failure> =>
    Option.filter(
      Option.fromNullishOr(Array.isArray(message) ? message[0] : message),
      isWordedBy(wording),
    )

export type Work =
  | 'command'
  | 'opening'
  | 'warming'
  | 'projecting'
  | 'forgetting'
  | 'reprojecting'
  | 'rereading'
  | 'rebuilding'
  | 'keeping'
  | 'listing'

export class Broke extends Data.TaggedError('Broke')<{
  readonly work: Work
  readonly subject: string
  readonly cause: string
}> {}

export const broke = (work: Work, subject: string, cause: Cause.Cause<unknown>): Broke =>
  new Broke({ work, subject, cause: reasonOf(Cause.squash(cause)) })

const works: { readonly [Each in Work]: (subject: string) => string } = {
  command: () => "Something broke in Loom's command line.",
  opening: (workspace) => `Something broke while Loom opened the workspace ${workspace}.`,
  warming: (loom) => `Something broke while Loom built the corpus of ${loom} ahead.`,
  projecting: (loom) => `Something broke while Loom prepared ${loom} for the editor.`,
  forgetting: (loom) => `Something broke while Loom forgot ${loom}.`,
  reprojecting: (loom) => `Something broke while Loom prepared ${loom} for the editor again.`,
  rereading: () => 'Something broke while Loom read the looms that changed on disk.',
  rebuilding: (loom) => `Something broke while Loom rebuilt ${loom} after an edit.`,
  keeping: (loom) => `Something broke while Loom kept the boxes of ${loom} in step.`,
  listing: (workspace) => `Something broke while Loom listed the books of ${workspace}.`,
}

const brokeWording: Wording<Broke> = {
  Broke: ({ work, subject, cause }) => problem(works[work](subject), reasonOf(cause)),
}

export type LoomFailure =
  | ReadingFailure
  | WritingFailure
  | TanglingFailure
  | PackageFailure
  | KeepingFailure
  | AskingFailure
  | Warning
  | Broke

export const failureWording: Wording<LoomFailure> = {
  ...readingWording,
  ...writingWording,
  ...tanglingWording,
  ...packageWording,
  ...keepingWording,
  ...askingWording,
  ...warningWording,
  ...brokeWording,
}

export const describe: (failure: LoomFailure) => Problem = Match.type<LoomFailure>().pipe(
  Match.tagsExhaustive(failureWording),
)

export const lineOf = ({ summary, detail }: Problem): string =>
  detail === '' ? summary : `${summary} ${detail}`
