import { Array, Effect, FileSystem, Option, pipe, Schema as S } from 'effect'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHighlighterCore, type HighlighterCore, type ThemeRegistration } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import { bundledLanguages, type BundledLanguage } from 'shiki/langs'
import {
  Corpus,
  TokenKind,
  type Block,
  type CodeBlock,
  type CodeLink,
  type CodeMark,
} from './model'

const GRAMMARS: ReadonlyMap<string, BundledLanguage> = new Map([
  ['typescript', 'typescript'],
  ['javascript', 'javascript'],
  ['json', 'json'],
  ['css', 'css'],
  ['html', 'html'],
  ['markdown', 'markdown'],
  ['yaml', 'yaml'],
  ['toml', 'toml'],
  ['dockerfile', 'dockerfile'],
  ['sh', 'shellscript'],
  ['c', 'c'],
  ['lua', 'lua'],
  ['rs', 'rust'],
  ['scm', 'scheme'],
])

const grammarOf = (language: string): Option.Option<BundledLanguage> =>
  Option.fromNullishOr(GRAMMARS.get(language))

const PLAIN = 'plain'

const SCOPES: ReadonlyArray<readonly [TokenKind | typeof PLAIN, ReadonlyArray<string>]> = [
  ['comment', ['comment', 'punctuation.definition.comment']],
  ['string', ['string', 'punctuation.definition.string']],
  ['constant', ['constant', 'support.constant', 'keyword.other.unit']],
  [
    'keyword',
    [
      'keyword',
      'storage',
      'keyword.operator.expression',
      'keyword.operator.new',
      'keyword.operator.word',
      'punctuation.definition.template-expression',
    ],
  ],
  ['function', ['entity.name.function', 'support.function', 'entity.other.attribute-name']],
  [
    'type',
    [
      'entity.name.type',
      'entity.name.class',
      'entity.name.tag',
      'entity.other.inherited-class',
      'support.type',
      'support.class',
      'storage.type.primitive',
    ],
  ],
  [PLAIN, ['keyword.operator', 'punctuation', 'meta.template.expression', 'meta.embedded']],
]

const THEME: ThemeRegistration = {
  name: 'loom-kinds',
  type: 'light',
  fg: PLAIN,
  bg: PLAIN,
  settings: [
    { settings: { foreground: PLAIN } },
    ...Array.map(SCOPES, ([kind, scope]) => ({ scope: [...scope], settings: { foreground: kind } })),
  ],
}

const makeHighlighter: Effect.Effect<HighlighterCore> = Effect.promise(() =>
  createHighlighterCore({
    themes: [THEME],
    langs: Array.map(Array.dedupe(GRAMMARS.values()), (grammar) => bundledLanguages[grammar]),
    engine: createOnigurumaEngine(import('shiki/wasm')),
  }),
)

const blanked = (block: CodeBlock): string =>
  Array.reduce(
    block.links,
    block.code,
    (code, link) =>
      code.slice(0, link.offset) + '_'.repeat(link.length) + code.slice(link.offset + link.length),
  )

const kindOf = S.decodeUnknownOption(TokenKind)

const overlaps = (mark: CodeMark, link: CodeLink): boolean =>
  mark.offset < link.offset + link.length && link.offset < mark.offset + mark.length

const marksOf = (highlighter: HighlighterCore, block: CodeBlock): ReadonlyArray<CodeMark> =>
  Option.match(grammarOf(block.language), {
    onNone: () => [],
    onSome: (lang) =>
      pipe(
        highlighter.codeToTokensBase(blanked(block), { lang, theme: THEME.name }),
        Array.flatten,
        Array.map((token) =>
          Option.map(
            kindOf(token.color),
            (kind): CodeMark => ({ offset: token.offset, length: token.content.length, kind }),
          ),
        ),
        Array.getSomes,
        Array.filter((mark) => !Array.some(block.links, (link) => overlaps(mark, link))),
      ),
  })

const colouredBlock =
  (highlighter: HighlighterCore) =>
  (block: Block): Block =>
    block.type === 'code' ? { ...block, marks: marksOf(highlighter, block) } : block

const colouredCorpus = (highlighter: HighlighterCore, corpus: Corpus): Corpus => ({
  ...corpus,
  pages: Array.map(corpus.pages, (page) => ({
    ...page,
    blocks: Array.map(page.blocks, colouredBlock(highlighter)),
  })),
})

const here = dirname(fileURLToPath(import.meta.url))

const BookFile = S.fromJsonString(Corpus)

const colourBook = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const book = yield* fs
    .readFileString(join(here, 'source.woven.json'))
    .pipe(Effect.flatMap(S.decodeUnknownEffect(BookFile)))
  const highlighter = yield* makeHighlighter
  const coloured = yield* S.encodeEffect(BookFile)(colouredCorpus(highlighter, book))
  yield* fs.writeFileString(join(here, 'source.coloured.json'), coloured)
})

colourBook.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
