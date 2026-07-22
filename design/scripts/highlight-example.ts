import { Array, Effect, Option, pipe } from 'effect'
import { BunRuntime } from '@effect/platform-bun'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHighlighter, type ShikiTransformer } from 'shiki'

const loomGrammar = {
  name: 'loom',
  scopeName: 'source.loom',
  patterns: [
    { include: '#frontmatter' },
    { include: '#codeblock' },
    { include: '#heading' },
    { include: '#anchor' },
    { include: '#tilde' },
  ],
  repository: {
    frontmatter: {
      begin: '\\A---\\s*$',
      end: '^---\\s*$',
      name: 'meta.frontmatter.loom',
      patterns: [{ match: '.+', name: 'meta.frontmatter.loom' }],
    },
    heading: {
      match: '^(#{1,6})\\s+(.*)$',
      captures: {
        1: { name: 'punctuation.definition.heading.loom' },
        2: {
          name: 'markup.heading.loom',
          patterns: [
            { match: '\\{[^}]*\\}', name: 'keyword.control.specifier.loom' },
            { match: '\\[[^\\]]*\\]', name: 'string.other.sink.loom' },
          ],
        },
      },
    },
    codeblock: {
      begin: '^=>\\s*$',
      end: '^(?=#{1,6}\\s)|^(?=~\\s*$)',
      beginCaptures: { 0: { name: 'keyword.operator.arrow.loom' } },
      contentName: 'meta.embedded.block.ts',
      patterns: [{ include: '#anchor' }, { include: 'source.ts' }],
    },
    anchor: { match: '::\\[[^\\]]*\\]', name: 'keyword.other.anchor.loom' },
    tilde: { match: '^~\\s*$', name: 'keyword.operator.tilde.loom' },
  },
  embeddedLangs: ['typescript'],
}

const loomCodeGrammar = {
  name: 'loomcode',
  scopeName: 'source.loomcode',
  patterns: [{ include: '#anchor' }, { include: 'source.ts' }],
  repository: {
    anchor: { match: '::\\[[^\\]]*\\]', name: 'keyword.other.anchor.loom' },
  },
  embeddedLangs: ['typescript'],
}

const loomTheme = {
  name: 'loom-dark',
  type: 'dark',
  colors: { 'editor.background': '#0F1014', 'editor.foreground': '#B6B8C2' },
  settings: [
    { scope: ['comment'], settings: { foreground: '#4D5260', fontStyle: 'italic' } },
    { scope: ['keyword', 'storage', 'storage.type', 'keyword.control', 'keyword.operator.new'], settings: { foreground: '#B59BF1' } },
    { scope: ['string', 'string.template', 'punctuation.definition.string'], settings: { foreground: '#8FE0B6' } },
    { scope: ['constant.numeric', 'constant.language'], settings: { foreground: '#E8B86C' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call'], settings: { foreground: '#6CC7E0' } },
    { scope: ['entity.name.type', 'support.type', 'entity.name.class', 'support.class'], settings: { foreground: '#6CC7E0' } },
    { scope: ['variable', 'meta.definition.variable', 'variable.other'], settings: { foreground: '#E6E6EA' } },
    { scope: ['keyword.operator'], settings: { foreground: '#8A92A6' } },
    { scope: ['punctuation', 'meta.brace'], settings: { foreground: '#7A7E8C' } },
    { scope: ['keyword.other.anchor.loom'], settings: { foreground: '#B59BF1', fontStyle: 'bold' } },
    { scope: ['markup.heading.loom'], settings: { foreground: '#E6E6EA', fontStyle: 'bold' } },
    { scope: ['punctuation.definition.heading.loom'], settings: { foreground: '#8FE0B6' } },
    { scope: ['keyword.control.specifier.loom'], settings: { foreground: '#E8B86C' } },
    { scope: ['string.other.sink.loom'], settings: { foreground: '#6CC7E0' } },
    { scope: ['keyword.operator.arrow.loom', 'keyword.operator.tilde.loom'], settings: { foreground: '#8FE0B6', fontStyle: 'bold' } },
    { scope: ['meta.frontmatter.loom'], settings: { foreground: '#7A7E8C' } },
  ],
}

type OutlineEntry = {
  readonly id: string
  readonly label: string
  readonly kind: string
}

const lineIds = (prefix: string): ShikiTransformer => ({
  name: 'line-ids',
  line(node, line) {
    node.properties['id'] = `${prefix}${line}`
    return node
  },
})

const cleanTitle = (title: string): string =>
  title
    .replace(/\s*\{[^}]*\}/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .trim()

const headingLine =
  (prefix: string) =>
  (line: string, index: number): Option.Option<OutlineEntry> => {
    const match = line.match(/^(#{1,2})\s+(.+)$/)
    return match === null
      ? Option.none()
      : Option.some({ id: `${prefix}${index + 1}`, label: cleanTitle(match[2] ?? ''), kind: '' })
  }

const symbolLine =
  (prefix: string) =>
  (line: string, index: number): Option.Option<OutlineEntry> => {
    const match = line.match(
      /^export (?:default )?(const|let|function|async function|class|abstract class|type|interface|enum) (\w+)/,
    )
    return match === null
      ? Option.none()
      : Option.some({ id: `${prefix}${index + 1}`, label: match[2] ?? '', kind: match[1] ?? '' })
  }

const outlineOf = (
  source: string,
  entry: (line: string, index: number) => Option.Option<OutlineEntry>,
): ReadonlyArray<OutlineEntry> =>
  pipe(source.split('\n'), Array.map(entry), Array.getSomes)

const example = '../examples/gomoku'
const theme = 'loom-dark'

type Block = { readonly type: string; readonly code?: string }
type Woven = { readonly pages: ReadonlyArray<{ readonly blocks: ReadonlyArray<Block> }> }

const read = (path: string): Effect.Effect<string, Error> =>
  Effect.try({
    try: () => readFileSync(path, 'utf8'),
    catch: (cause) => new Error(`cannot read ${path}: ${String(cause)}`),
  })

const program = Effect.gen(function* () {
  const loomSource = yield* read(`${example}/gomoku.loom`)
  const tangledSource = yield* read(`${example}/gomoku.ts`)
  const woven: Woven = JSON.parse(yield* read('src/gomoku.woven.json'))

  const highlighter = yield* Effect.tryPromise(() =>
    createHighlighter({ langs: [loomGrammar, loomCodeGrammar, 'typescript'], themes: [loomTheme] }),
  )

  const codeHtml = pipe(
    woven.pages[0].blocks,
    Array.filter((block) => block.type === 'code'),
    Array.map((block) => highlighter.codeToHtml(block.code ?? '', { lang: 'loomcode', theme })),
  )

  const data = {
    loomHtml: highlighter.codeToHtml(loomSource, {
      lang: 'loom',
      theme,
      transformers: [lineIds('loom-')],
    }),
    tangledHtml: highlighter.codeToHtml(tangledSource, {
      lang: 'typescript',
      theme,
      transformers: [lineIds('ts-')],
    }),
    sourceOutline: outlineOf(loomSource, headingLine('loom-')),
    tangledOutline: outlineOf(tangledSource, symbolLine('ts-')),
    codeHtml,
  }

  yield* Effect.sync(() =>
    writeFileSync('src/gomoku.highlighted.json', `${JSON.stringify(data, null, 2)}\n`),
  )
})

BunRuntime.runMain(program)
