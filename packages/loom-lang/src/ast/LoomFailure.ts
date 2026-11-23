import { Cause, Data, Match, Option } from 'effect'
import { defaultAnchorDelims, type InvalidAnchorDelims } from '@athrio/loom-ast/LoomTokens'
import type { ServiceError } from '@athrio/loom-lang-services/LanguageService'
import type { StoreError } from '@athrio/loom-lang-services/LoomStore'
import type { ReadError } from '#ast/LoomCorpusAstBuilder'
import type { TangleError } from '../LoomCompiler'
import type { ClassicTypeScriptMissing, TypeScriptNotFetched } from '../LoomServer'
import type { NotRemoved, NotWritten } from '../LoomTangler'
import type { RelationsNotKept, StorageTakesNoWrite } from '../WorkspaceSource'

export type Problem = { readonly summary: string; readonly detail: string }

export const problem = (summary: string, detail = ''): Problem => ({ summary, detail })

const closed = (words: string): string => (/(^|[.!?])$/.test(words) ? words : `${words}.`)

export const reasonOf = (cause: unknown): string =>
  closed(cause instanceof Error ? cause.message : String(cause))

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

export type WritingFailure = NotWritten | NotRemoved

const writingWording: Wording<WritingFailure> = {
  NotWritten: ({ path, cause }) => problem(`Loom could not write ${path}.`, reasonOf(cause)),
  NotRemoved: ({ path, cause }) => problem(`Loom could not remove ${path}.`, reasonOf(cause)),
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
  forgetting: (loom) => `Something broke while Loom forgot ${loom}, which was deleted.`,
  reprojecting: (loom) => `Something broke while Loom prepared ${loom} for the editor again.`,
  rereading: () => 'Something broke while Loom read the looms that changed on disk.',
  rebuilding: (loom) => `Something broke while Loom rebuilt ${loom} after an edit.`,
  keeping: (loom) => `Something broke while Loom kept the boxes of ${loom} in step.`,
}

const brokeWording: Wording<Broke> = {
  Broke: ({ work, subject, cause }) => problem(works[work](subject), reasonOf(cause)),
}

export type LoomFailure =
  ReadingFailure | WritingFailure | TanglingFailure | PackageFailure | KeepingFailure | Broke

export const failureWording: Wording<LoomFailure> = {
  ...readingWording,
  ...writingWording,
  ...tanglingWording,
  ...packageWording,
  ...keepingWording,
  ...brokeWording,
}

export const describe: (failure: LoomFailure) => Problem = Match.type<LoomFailure>().pipe(
  Match.tagsExhaustive(failureWording),
)

export const lineOf = ({ summary, detail }: Problem): string =>
  detail === '' ? summary : `${summary} ${detail}`
