import { Array, Match, Option, Order, pipe } from 'effect'
import { marked } from 'marked'
import type { Html, HtmlBuilder } from 'foldkit/html'
import {
  ClosedDrawer,
  Copied,
  OpenedChapter,
  PickedRuntime,
  SelectedSection,
  type Block,
  type Chapter,
  type CodeBlock,
  type CodeLink,
  type Corpus,
  type HeadingBlock,
  type Message,
  type Model,
  type Page,
  type Part,
  type Runtime,
  type TokenKind,
} from './model'
import {
  broadSeam,
  bunIcon,
  type Carpet,
  carpetMark,
  checkIcon,
  copyIcon,
  editorMark,
  flowerFor,
  loomMark,
  nodeIcon,
  octocatIcon,
} from './components'
import { commandButton, installLine } from './hero'
import { loomCanvas } from './example'
import { starCard } from './page-head'
import { operations } from './operations'
import projectDrawing from './project.svg?raw'
import wovenDocs from './docs.woven.json'

export const docsCorpus = wovenDocs as unknown as Corpus

export const firstSlugOf = (corpus: Corpus): string =>
  pipe(
    Option.fromNullishOr(corpus.pages[0]),
    Option.map((page) => page.slug),
    Option.getOrElse(() => ''),
  )

const pageOf = (corpus: Corpus, slug: string): Option.Option<Page> =>
  Array.findFirst(corpus.pages, (page) => page.slug === slug)

const partOf = (corpus: Corpus, slug: string): Option.Option<Part> =>
  Array.findFirst(corpus.nav, (part) =>
    Array.some(part.chapters, (chapter) => chapter.slug === slug),
  )

const readingOrder = (corpus: Corpus): ReadonlyArray<Chapter> =>
  Array.flatMap(corpus.nav, (part) => part.chapters)

const readable = (slug: string): string =>
  pipe(
    slug.split('/'),
    Array.map((segment) => segment.replace(/^\d+-/, '')),
    Array.join('/'),
  )

export const chapterPath = (base: string, slug: string): string => `${base}/${readable(slug)}`

export const chapterAt = (corpus: Corpus, base: string, pathname: string): Option.Option<string> =>
  pipe(
    Array.findFirst(corpus.pages, (page) => chapterPath(base, page.slug) === pathname),
    Option.map((page) => page.slug),
  )

export const docsChapterAt = (pathname: string): Option.Option<string> =>
  chapterAt(docsCorpus, '/docs', pathname)

export const sliceOf = (corpus: Corpus, slug: string): Corpus => {
  const shown = slug === '' ? firstSlugOf(corpus) : slug
  return { nav: corpus.nav, pages: Array.filter(corpus.pages, (page) => page.slug === shown) }
}

type Section = {
  readonly heading: HeadingBlock
  readonly blocks: ReadonlyArray<Block>
}

type Cut = {
  readonly title: Option.Option<HeadingBlock>
  readonly opening: ReadonlyArray<Block>
  readonly sections: ReadonlyArray<Section>
}

const isTitle = (block: Block): block is HeadingBlock =>
  block.type === 'heading' && block.level === 1

const isSectionHead = (block: Block): block is HeadingBlock =>
  block.type === 'heading' && block.level === 2

const grow = (sections: ReadonlyArray<Section>, block: Block): ReadonlyArray<Section> =>
  isSectionHead(block)
    ? Array.append(sections, { heading: block, blocks: [] })
    : pipe(
        Array.last(sections),
        Option.match({
          onNone: () => sections,
          onSome: (last) =>
            Array.append(Array.dropRight(sections, 1), {
              ...last,
              blocks: Array.append(last.blocks, block),
            }),
        }),
      )

const cutOf = (page: Page): Cut => {
  const body = Array.filter(page.blocks, (block) => !isTitle(block))
  const [opening, rest] = Array.span(body, (block) => !isSectionHead(block))
  return {
    title: Array.findFirst(page.blocks, isTitle),
    opening,
    sections: Array.reduce(rest, [] as ReadonlyArray<Section>, grow),
  }
}

type Piece =
  | { readonly type: 'text'; readonly markdown: string }
  | { readonly type: 'fence'; readonly kind: string; readonly body: string }

const FENCE = /^```([\w-]*)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m

const piecesOf = (markdown: string): ReadonlyArray<Piece> => {
  const [first, ...rest] = markdown.split(FENCE)
  return Array.filter(
    [
      { type: 'text', markdown: first ?? '' } as Piece,
      ...Array.flatMap(Array.chunksOf(rest, 3), ([kind, body, after]): ReadonlyArray<Piece> => [
        { type: 'fence', kind: kind ?? '', body: body ?? '' },
        { type: 'text', markdown: after ?? '' },
      ]),
    ],
    (piece) => piece.type === 'fence' || piece.markdown.trim() !== '',
  )
}

const textOf = (
  markdown: string,
  className: string,
  copied: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class(className), h.InnerHTML(inlineCommands(marked.parse(markdown) as string, copied))],
    [],
  )

const INLINE_COMMAND = /<code>\$ ([^<]+)<\/code>/g

const COPY_GLYPH =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>'

const TICK_GLYPH =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>'

const ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&amp;', '&'],
]

const commandOf = (escaped: string): string =>
  Array.reduce(ENTITIES, escaped, (text, [entity, glyph]) => text.split(entity).join(glyph))

const COMMAND_INKS: ReadonlyArray<readonly [string, string]> = [
  ['loom init', 'var(--init)'],
  ['loom tangle', 'var(--tangle)'],
  ['loom weave', 'var(--weave)'],
  ['loom eject', 'var(--eject)'],
]

const inkOf = (command: string): string =>
  pipe(
    Array.findFirst(COMMAND_INKS, ([name]) => command === name || command.startsWith(`${name} `)),
    Option.map(([, ink]) => ink),
    Option.getOrElse(() => 'var(--prompt-paper)'),
  )

const inlineCommands = (html: string, copied: string): string =>
  html.replace(INLINE_COMMAND, (_, escaped: string) => {
    const command = commandOf(escaped)
    const done = copied === `inline:${command}`
    return `<button type="button" class="${done ? 'inline-copy done' : 'inline-copy'}" style="--cmd-ink: ${inkOf(command)}" data-copy="${escaped}" title="Copy the command"><code>${escaped}</code>${done ? TICK_GLYPH : COPY_GLYPH}</button>`
  })

const fenceOf = (kind: string, body: string, model: Model, h: HtmlBuilder<Message>): Html =>
  Match.value(kind).pipe(
    Match.when('install', () => installLine(model, h)),
    Match.when('picture', () => pictureOf(body.trim(), h)),
    Match.when('run', () => runLine(body.trim(), model, h)),
    Match.when('loom', () => loomCanvas(body, model.copied, h)),
    Match.when('bash', () => commandsOf(body, model, h)),
    Match.orElse(() => codeSheet(body, model.copied, h)),
  )

const commandsOf = (body: string, model: Model, h: HtmlBuilder<Message>): Html => {
  const lines = pipe(
    body.split('\n'),
    Array.map((line) => line.trim()),
    Array.filter((line) => line !== ''),
  )
  return pipe(
    Array.head(lines),
    Option.filter(() => lines.length === 1),
    Option.match({
      onNone: () => codeSheet(body, model.copied, h),
      onSome: (command) =>
        h.div(
          [h.Class('docs-command')],
          [commandButton(`command:${command}`, command, model.copied, h)],
        ),
    }),
  )
}

const copyButton = (code: string, copied: string, h: HtmlBuilder<Message>): Html => {
  const id = `code:${code}`
  const taken = copied === id
  return h.button(
    [
      h.Class(taken ? 'canvas-copy done' : 'canvas-copy'),
      h.Type('button'),
      h.Title(taken ? 'Copied' : 'Copy the code'),
      h.AriaLabel('Copy the code'),
      h.OnClick(Copied({ id, text: code })),
    ],
    [taken ? checkIcon() : copyIcon()],
  )
}

const codeSheet = (body: string, copied: string, h: HtmlBuilder<Message>): Html => {
  const code = body.replace(/\n$/, '')
  return h.div(
    [h.Class('docs-canvas')],
    [copyButton(code, copied, h), h.pre([h.Class('sheet-code')], [h.code([], [code])])],
  )
}

type Picture = { readonly name: string; readonly drawing: string }

const docsPictures: ReadonlyArray<Picture> = [{ name: 'project', drawing: projectDrawing }]

const landingPicture = (command: string): Option.Option<string> =>
  pipe(
    Array.findFirst(operations, (operation) => operation.command === command),
    Option.flatMap((operation) => Option.fromNullishOr(operation.drawing)),
  )

const pictureOf = (name: string, h: HtmlBuilder<Message>): Html =>
  pipe(
    Array.findFirst(docsPictures, (picture) => picture.name === name),
    Option.map((picture) => picture.drawing),
    Option.orElse(() => landingPicture(name)),
    Option.match({
      onNone: () => h.div([], []),
      onSome: (drawing) =>
        h.div(
          [h.Class('ops-frame doc-picture')],
          [h.div([h.Class('ops-svg'), h.InnerHTML(drawing)], [])],
        ),
    }),
  )

type Runner = {
  readonly runtime: Runtime
  readonly label: string
  readonly logo: Html
}

const bunRunner: Runner = { runtime: 'bun', label: 'bun', logo: bunIcon() }
const nodeRunner: Runner = { runtime: 'npm', label: 'node', logo: nodeIcon() }

const runnerOf = (runtime: Runtime): Runner =>
  Match.value(runtime).pipe(
    Match.when('bun', () => bunRunner),
    Match.orElse(() => nodeRunner),
  )

const runLine = (file: string, model: Model, h: HtmlBuilder<Message>): Html => {
  const chosen = runnerOf(model.runtime)
  return h.div(
    [h.Class('hero-install')],
    [
      h.div(
        [h.Class('rt-tabs')],
        Array.map([bunRunner, nodeRunner], (runner) =>
          h.button(
            [
              h.Class(runner.label === chosen.label ? 'rt-tab here' : 'rt-tab'),
              h.Type('button'),
              h.OnClick(PickedRuntime({ runtime: runner.runtime })),
            ],
            [runner.logo, runner.label],
          ),
        ),
      ),
      commandButton(`run:${file}`, `${chosen.label} ${file}`, model.copied, h),
    ],
  )
}

type Run =
  | { readonly type: 'plain'; readonly text: string }
  | { readonly type: 'anchor'; readonly text: string; readonly link: CodeLink }
  | { readonly type: 'mark'; readonly text: string; readonly kind: TokenKind }

type Span = {
  readonly offset: number
  readonly length: number
  readonly runOf: (text: string) => Run
}

const byOffset = Order.mapInput(Order.Number, (span: Span) => span.offset)

const spansOf = (block: CodeBlock): ReadonlyArray<Span> =>
  Array.sort(
    [
      ...Array.map(block.links, (link): Span => ({
        offset: link.offset,
        length: link.length,
        runOf: (text) => ({ type: 'anchor', text, link }),
      })),
      ...Array.map(block.marks, (mark): Span => ({
        offset: mark.offset,
        length: mark.length,
        runOf: (text) => ({ type: 'mark', text, kind: mark.kind }),
      })),
    ],
    byOffset,
  )

const plain = (text: string): Run => ({ type: 'plain', text })

const runsOf = (block: CodeBlock): ReadonlyArray<Run> => {
  const spans = spansOf(block)
  const ends = Array.map(spans, (span) => span.offset + span.length)
  return Array.filter(
    [
      ...Array.flatMap(Array.zip([0, ...ends], spans), ([from, span]) => [
        plain(block.code.slice(from, span.offset)),
        span.runOf(block.code.slice(span.offset, span.offset + span.length)),
      ]),
      plain(block.code.slice(Option.getOrElse(Array.last(ends), () => 0))),
    ],
    (run) => run.text !== '',
  )
}

const ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
  [/"/g, '&quot;'],
]

const escaped = (text: string): string =>
  Array.reduce(ESCAPES, text, (out, [pattern, entity]) => out.replace(pattern, entity))

const runHtml = (run: Run, base: string, page: Page): string =>
  Match.value(run).pipe(
    Match.when({ type: 'plain' }, (plain) => escaped(plain.text)),
    Match.when(
      { type: 'anchor' },
      (anchor) =>
        `<a class="code-anchor" href="${escaped(anchorHref(base, page.slug, anchor.link))}">${escaped(anchor.text)}</a>`,
    ),
    Match.when(
      { type: 'mark' },
      (mark) => `<span class="tok-${mark.kind}">${escaped(mark.text)}</span>`,
    ),
    Match.exhaustive,
  )

const anchorHref = (base: string, here: string, link: CodeLink): string =>
  link.targetSlug === here
    ? `#${link.targetId}`
    : `${chapterPath(base, link.targetSlug)}#${link.targetId}`

const codeTag = (block: CodeBlock, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.Class('code-tag')],
    [...Option.toArray(emblemOf(block.language, 14, h)), nameOf(block.language)],
  )

const codeOf = (
  block: CodeBlock,
  base: string,
  page: Page,
  copied: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('docs-canvas source-code')],
    [
      codeTag(block, h),
      copyButton(block.code, copied, h),
      h.pre(
        [h.Class('sheet-code')],
        [
          h.code(
            [
              h.InnerHTML(
                Array.join(
                  Array.map(runsOf(block), (run) => runHtml(run, base, page)),
                  '',
                ),
              ),
            ],
            [],
          ),
        ],
      ),
    ],
  )

const blockOf = (
  block: Block,
  base: string,
  page: Page,
  model: Model,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Match.value(block).pipe(
    Match.when({ type: 'heading' }, (heading) => [h.h3([h.Id(heading.id)], [heading.title])]),
    Match.when({ type: 'prose' }, (prose) =>
      Array.map(piecesOf(prose.markdown), (piece) =>
        piece.type === 'text'
          ? textOf(piece.markdown, 'docs-prose', model.copied, h)
          : fenceOf(piece.kind, piece.body, model, h),
      ),
    ),
    Match.when({ type: 'code' }, (code) => [codeOf(code, base, page, model.copied, h)]),
    Match.when({ type: 'note' }, (note) =>
      note.markdown.trim() === '' ? [] : [textOf(note.markdown, 'docs-prose doc-note', model.copied, h)],
    ),
    Match.exhaustive,
  )

const markOf = (flower: Option.Option<Carpet>, section: Section): Option.Option<Html> =>
  Option.orElse(editorMark(section.heading.title), () =>
    Option.map(flower, (carpet) => carpetMark(carpet, '42px', broadSeam)),
  )

const sectionOf = (
  mark: Option.Option<Html>,
  section: Section,
  base: string,
  page: Page,
  model: Model,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('section doc-section')],
    [
      h.div(
        [h.Class('section-head')],
        [
          ...Option.toArray(mark),
          h.div([h.Class('lines')], [h.h2([h.Id(section.heading.id)], [section.heading.title])]),
        ],
      ),
      h.div(
        [h.Class('doc-stack')],
        Array.flatMap(section.blocks, (block) => blockOf(block, base, page, model, h)),
      ),
    ],
  )

const crumbLink = (label: string, href: string, slug: string, h: HtmlBuilder<Message>): Html =>
  h.a([h.Class('crumb'), h.Href(href), h.OnClick(OpenedChapter({ slug }))], [label])

const breadcrumb = (
  corpus: Corpus,
  root: string,
  base: string,
  page: Page,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('eyebrow doc-crumbs')],
    [
      crumbLink(root, base, firstSlugOf(corpus), h),
      h.span([h.Class('sep'), h.AriaHidden(true)], ['/']),
      ...pipe(
        partOf(corpus, page.slug),
        Option.flatMap((part) =>
          Option.map(Array.head(part.chapters), (first) => [
            crumbLink(part.name, chapterPath(base, first.slug), first.slug, h),
            h.span([h.Class('sep'), h.AriaHidden(true)], ['/']),
          ]),
        ),
        Option.getOrElse((): ReadonlyArray<Html> => []),
      ),
      h.span([h.Class('here')], [page.title]),
    ],
  )

const openingPieces = (cut: Cut): ReadonlyArray<Piece> =>
  Array.flatMap(cut.opening, (block) => (block.type === 'prose' ? piecesOf(block.markdown) : []))

const textsOf = (pieces: ReadonlyArray<Piece>): ReadonlyArray<string> =>
  Array.flatMap(pieces, (piece) => (piece.type === 'text' ? [piece.markdown] : []))

const PARAGRAPH_BREAK = /\n[ \t]*\n/

const gistAndRest = (
  texts: ReadonlyArray<string>,
): readonly [Option.Option<string>, ReadonlyArray<string>] =>
  Array.match(texts, {
    onEmpty: () => [Option.none(), []] as const,
    onNonEmpty: ([first, ...others]) => {
      const at = first.search(PARAGRAPH_BREAK)
      const [gist, more] = at < 0 ? [first, ''] : [first.slice(0, at), first.slice(at)]
      return [
        Option.some(gist),
        Array.filter([more, ...others], (text) => text.trim() !== ''),
      ] as const
    },
  })

const chapterHeading = (page: Page, cut: Cut): HeadingBlock =>
  Option.getOrElse(cut.title, (): HeadingBlock => ({
    type: 'heading',
    level: 1,
    title: page.title,
    id: page.slug,
  }))

const docHead = (
  corpus: Corpus,
  root: string,
  base: string,
  page: Page,
  cut: Cut,
  model: Model,
  h: HtmlBuilder<Message>,
): Html => {
  const pieces = openingPieces(cut)
  const [gist] = gistAndRest(textsOf(pieces))
  const heading = chapterHeading(page, cut)
  return h.div(
    [h.Class('section section-hero page-hero doc-hero')],
    [
      h.div(
        [h.Class('doc-hero-grid')],
        [
          h.div(
            [h.Class('doc-hero-lead')],
            [
              breadcrumb(corpus, root, base, page, h),
              h.div(
                [h.Class('page-title')],
                [loomMark('page', 0.8), h.h1([h.Id(heading.id)], [heading.title])],
              ),
              ...Option.toArray(
                Option.map(gist, (markdown) => textOf(markdown, 'docs-prose page-lead', model.copied, h)),
              ),
            ],
          ),
          h.div(
            [h.Class('hero-cli')],
            Array.flatMap(pieces, (piece) =>
              piece.type === 'fence' ? [fenceOf(piece.kind, piece.body, model, h)] : [],
            ),
          ),
        ],
      ),
    ],
  )
}

const placeOf = (corpus: Corpus, page: Page): string =>
  pipe(
    partOf(corpus, page.slug),
    Option.filter((part) => part.number !== ''),
    Option.flatMap((part) =>
      Option.map(
        Array.findFirst(part.chapters, (chapter) => chapter.slug === page.slug),
        (chapter) => `Part ${part.number}, Chapter ${chapter.number}`,
      ),
    ),
    Option.getOrElse(() => page.title),
  )

const REPOSITORY = 'https://github.com/athrio-com/loom/blob/main'

const rawSource = (page: Page): string => `${REPOSITORY}/corpus/${page.slug}.loom`

const FIELD = /^([^:]+:)(.*)$/

const frontmatterField = (line: string, h: HtmlBuilder<Message>): Html =>
  Option.match(Option.fromNullishOr(FIELD.exec(line)), {
    onNone: () => h.p([h.Class('front-field')], [line]),
    onSome: ([, key, value]) =>
      h.p([h.Class('front-field')], [h.span([h.Class('front-key')], [key ?? '']), value ?? '']),
  })

const frontmatterText = (page: Page, text: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('frontmatter')],
    [
      ...pipe(
        text.split('\n'),
        Array.filter((line) => line.trim() !== '' && line.trim() !== '---'),
        Array.map((line) => frontmatterField(line, h)),
      ),
      h.a(
        [
          h.Class('raw-source'),
          h.Href(rawSource(page)),
          h.Target('_blank'),
          h.Rel('noopener noreferrer'),
        ],
        [octocatIcon('14'), 'Raw source'],
      ),
    ],
  )

const sourceHead = (
  corpus: Corpus,
  root: string,
  base: string,
  page: Page,
  cut: Cut,
  model: Model,
  h: HtmlBuilder<Message>,
): Html => {
  return h.div(
    [h.Class('section section-hero page-hero doc-hero source-hero')],
    [
      h.div(
        [h.Class('source-head')],
        [
          h.div(
            [h.Class('source-head-main')],
            [
              breadcrumb(corpus, root, base, page, h),
              h.div(
                [h.Class('page-title')],
                [loomMark('page', 0.8), h.p([h.Class('page-place')], [placeOf(corpus, page)])],
              ),
              ...Option.toArray(
                Option.map(Option.fromNullishOr(page.frontmatter), (text) =>
                  frontmatterText(page, text, h),
                ),
              ),
            ],
          ),
          h.div([h.Class('page-places')], [starCard()]),
        ],
      ),
    ],
  )
}

const LANGUAGE_LINE = /^Language:[ \t]*(.+)$/m

const chapterLanguage = (page: Page): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(page.frontmatter),
    Option.flatMap((text) => Option.fromNullishOr(LANGUAGE_LINE.exec(text)?.[1])),
    Option.map((language) => language.trim().toLowerCase()),
  )

const isCode = (block: Block): block is CodeBlock => block.type === 'code'

const sectionLanguage = (section: Section): Option.Option<string> =>
  Option.map(Array.findFirst(section.blocks, isCode), (code) => code.language.toLowerCase())

const ICONS: ReadonlyMap<string, string> = new Map([
  ['typescript', 'typescript'],
  ['javascript', 'javascript'],
  ['css', 'css'],
  ['html', 'html'],
  ['json', 'json'],
  ['yaml', 'yaml'],
  ['toml', 'toml'],
  ['markdown', 'markdown'],
  ['scm', 'scm'],
  ['c', 'c'],
  ['h', 'c'],
  ['rust', 'rust'],
  ['rs', 'rust'],
  ['bash', 'bash'],
  ['sh', 'bash'],
  ['lua', 'lua'],
  ['dockerfile', 'dockerfile'],
  ['gitignore', 'git'],
  ['gitattributes', 'git'],
  ['vscodeignore', 'vscode'],
  ['prose', 'loom'],
])

const NAMES: ReadonlyMap<string, string> = new Map([
  ['typescript', 'TypeScript'],
  ['javascript', 'JavaScript'],
  ['css', 'CSS'],
  ['html', 'HTML'],
  ['json', 'JSON'],
  ['yaml', 'YAML'],
  ['toml', 'TOML'],
  ['markdown', 'Markdown'],
  ['scm', 'Query'],
  ['c', 'C'],
  ['h', 'C'],
  ['rust', 'Rust'],
  ['rs', 'Rust'],
  ['bash', 'Bash'],
  ['sh', 'Bash'],
  ['lua', 'Lua'],
  ['dockerfile', 'Dockerfile'],
  ['prose', 'Prose'],
])

const nameOf = (language: string): string => NAMES.get(language) ?? language

const iconOf = (language: string): Option.Option<string> =>
  Option.fromNullishOr(ICONS.get(language))

const sameLanguage = (one: string, other: string): boolean =>
  one === other || Option.exists(iconOf(one), (icon) => Option.contains(iconOf(other), icon))

const iconMark = (icon: string, size: number, h: HtmlBuilder<Message>): Html =>
  h.img([
    h.Class('lang-icon'),
    h.Src(`/languages/${icon}.svg`),
    h.Alt(''),
    h.Width(String(size)),
    h.Height(String(size)),
  ])

const emblemOf = (language: string, size: number, h: HtmlBuilder<Message>): Option.Option<Html> =>
  Option.map(iconOf(language), (icon) => iconMark(icon, size, h))

const chapterEmblem = (page: Page, h: HtmlBuilder<Message>): Option.Option<Html> =>
  Option.flatMap(chapterLanguage(page), (language) => emblemOf(language, 42, h))

const languageMark =
  (page: Page, h: HtmlBuilder<Message>) =>
  (section: Section): Option.Option<Html> =>
    pipe(
      sectionLanguage(section),
      Option.filter(
        (language) => !Option.exists(chapterLanguage(page), (chapter) => sameLanguage(chapter, language)),
      ),
      Option.flatMap((language) => emblemOf(language, 42, h)),
    )

const chapterIcon = (chapter: Chapter, size: number, h: HtmlBuilder<Message>): Option.Option<Html> =>
  Option.flatMap(Option.fromNullishOr(chapter.language), (language) =>
    emblemOf(language.toLowerCase(), size, h),
  )

const menuEmblem =
  (h: HtmlBuilder<Message>) =>
  (chapter: Chapter): Option.Option<Html> =>
    chapterIcon(chapter, 16, h)

const sectionButton = (section: Section, here: boolean, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Class(here ? 'menu-sub here' : 'menu-sub'),
      h.Type('button'),
      h.OnClick(SelectedSection({ id: section.heading.id })),
    ],
    [section.heading.title],
  )

const reachedOf = (cut: Cut, active: string): string =>
  active !== ''
    ? active
    : pipe(
        Array.head(cut.sections),
        Option.map((section) => section.heading.id),
        Option.getOrElse(() => ''),
      )

const chapterRows = (
  chapter: Chapter,
  page: Page,
  cut: Cut,
  active: string,
  base: string,
  markFor: (chapter: Chapter) => Option.Option<Html>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const mark = Option.toArray(markFor(chapter))
  const marked = Array.isReadonlyArrayNonEmpty(mark) ? ' marked' : ''
  return chapter.slug === page.slug
    ? [
        h.a(
          [h.Class(`menu-item here${marked}`), h.Href(chapterPath(base, chapter.slug))],
          [...mark, chapter.title],
        ),
        h.div(
          [h.Class('menu-subs')],
          Array.map(cut.sections, (section) =>
            sectionButton(section, section.heading.id === reachedOf(cut, active), h),
          ),
        ),
      ]
    : [
        h.a(
          [
            h.Class(`menu-item${marked}`),
            h.Href(chapterPath(base, chapter.slug)),
            h.OnClick(OpenedChapter({ slug: chapter.slug })),
          ],
          [...mark, chapter.title],
        ),
      ]
}

const menuGroups = (
  corpus: Corpus,
  page: Page,
  cut: Cut,
  active: string,
  base: string,
  markFor: (chapter: Chapter) => Option.Option<Html>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Array.map(corpus.nav, (part) =>
    h.div(
      [h.Class('menu-part')],
      [
        h.span([h.Class('eyebrow')], [part.name]),
        ...Array.flatMap(part.chapters, (chapter) =>
          chapterRows(chapter, page, cut, active, base, markFor, h),
        ),
      ],
    ),
  )

const menu = (
  corpus: Corpus,
  page: Page,
  cut: Cut,
  active: string,
  base: string,
  markFor: (chapter: Chapter) => Option.Option<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.nav(
    [h.Class('menu-card thin-scroll'), h.AriaLabel('Chapters')],
    menuGroups(corpus, page, cut, active, base, markFor, h),
  )

const chapterFlower = (corpus: Corpus, slug: string): Carpet =>
  flowerFor(
    pipe(
      Array.findFirstIndex(readingOrder(corpus), (chapter) => chapter.slug === slug),
      Option.getOrElse(() => 0),
    ),
  )

const chapterCard = (
  corpus: Corpus,
  base: string,
  chapter: Chapter,
  direction: 'Previous' | 'Next',
  cardMark: (chapter: Chapter) => Html,
  h: HtmlBuilder<Message>,
): Html => {
  const mark = cardMark(chapter)
  const words = h.div(
    [h.Class('pager-words')],
    [h.span([h.Class('eyebrow')], [direction]), h.span([h.Class('pager-title')], [chapter.title])],
  )
  return h.a(
    [
      h.Class(direction === 'Next' ? 'pager-card next' : 'pager-card'),
      h.Href(chapterPath(base, chapter.slug)),
      h.Style({ '--pg-ink': '#C2410C' }),
      h.OnClick(OpenedChapter({ slug: chapter.slug })),
    ],
    direction === 'Next' ? [words, mark] : [mark, words],
  )
}

const chapterPager = (
  corpus: Corpus,
  base: string,
  page: Page,
  cardMark: (chapter: Chapter) => Html,
  h: HtmlBuilder<Message>,
): Html => {
  const order = readingOrder(corpus)
  const at = Array.findFirstIndex(order, (chapter) => chapter.slug === page.slug)
  const step = (by: number): Option.Option<Chapter> =>
    Option.flatMap(at, (index) => Array.get(order, index + by))
  return h.div(
    [h.Class('pager-row doc-pager')],
    [
      ...Option.toArray(
        Option.map(step(-1), (chapter) =>
          chapterCard(corpus, base, chapter, 'Previous', cardMark, h),
        ),
      ),
      ...Option.toArray(
        Option.map(step(1), (chapter) => chapterCard(corpus, base, chapter, 'Next', cardMark, h)),
      ),
    ],
  )
}

const closeIcon = (h: HtmlBuilder<Message>): Html =>
  h.svg(
    [
      h.Width('15'),
      h.Height('15'),
      h.ViewBox('0 0 24 24'),
      h.Fill('none'),
      h.Stroke('currentColor'),
      h.StrokeWidth('2'),
      h.StrokeLinecap('round'),
      h.AriaHidden(true),
    ],
    [
      h.line([h.X1('5'), h.Y1('5'), h.X2('19'), h.Y2('19')], []),
      h.line([h.X1('19'), h.Y1('5'), h.X2('5'), h.Y2('19')], []),
    ],
  )

const drawer = (
  corpus: Corpus,
  base: string,
  page: Page,
  cut: Cut,
  model: Model,
  markFor: (chapter: Chapter) => Option.Option<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class(model.drawerOpen ? 'docs-drawer open' : 'docs-drawer')],
    [
      h.div(
        [h.Class('drawer-head')],
        [
          loomMark('page', 0.495),
          h.span([h.Class('drawer-word')], ['Loom']),
          h.button(
            [
              h.Class('drawer-close'),
              h.Type('button'),
              h.AriaLabel('Close menu'),
              h.OnClick(ClosedDrawer()),
            ],
            [closeIcon(h)],
          ),
        ],
      ),
      h.div(
        [h.Class('drawer-body thin-scroll')],
        menuGroups(corpus, page, cut, model.activeSection, base, markFor, h),
      ),
    ],
  )

const scrim = (open: boolean, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(open ? 'docs-scrim open' : 'docs-scrim'),
      h.AriaHidden(true),
      h.OnClick(ClosedDrawer()),
    ],
    [],
  )

type Opening = {
  readonly above: ReadonlyArray<Html>
  readonly lead: ReadonlyArray<Html>
  readonly markOf: (section: Section, place: number) => Option.Option<Html>
  readonly cardMark: (chapter: Chapter) => Html
  readonly menuMark: (chapter: Chapter) => Option.Option<Html>
}

type OpeningOf = (
  corpus: Corpus,
  root: string,
  base: string,
  page: Page,
  cut: Cut,
  model: Model,
  h: HtmlBuilder<Message>,
) => Opening

export const docsOpening: OpeningOf = (corpus, root, base, page, cut, model, h) => {
  const [, rest] = gistAndRest(textsOf(openingPieces(cut)))
  const leading = [
    ...Array.map(rest, (markdown) => textOf(markdown, 'docs-prose', model.copied, h)),
    ...pipe(
      cut.opening,
      Array.filter((block) => block.type === 'code' || block.type === 'note'),
      Array.flatMap((block) => blockOf(block, base, page, model, h)),
    ),
  ]
  return {
    cardMark: (chapter) => carpetMark(chapterFlower(corpus, chapter.slug), '42px', broadSeam),
    markOf: (section, place) =>
      markOf(place === 0 ? Option.some(chapterFlower(corpus, page.slug)) : Option.none(), section),
    menuMark: () => Option.none(),
    above: [docHead(corpus, root, base, page, cut, model, h)],
    lead: Array.isReadonlyArrayNonEmpty(leading)
      ? [h.div([h.Class('doc-stack doc-opening')], leading)]
      : [],
  }
}

const sourceOpening: OpeningOf = (corpus, root, base, page, cut, model, h) => {
  const heading = chapterHeading(page, cut)
  return {
    cardMark: (chapter) => Option.getOrElse(chapterIcon(chapter, 42, h), () => iconMark('loom', 42, h)),
    markOf: languageMark(page, h),
    menuMark: menuEmblem(h),
    above: [sourceHead(corpus, root, base, page, cut, model, h)],
    lead: [
      h.div(
        [h.Class('doc-stack doc-opening')],
        [
          h.div(
            [h.Class('section-head chapter-head')],
            [
              ...Option.toArray(
                chapterEmblem(page, h),
              ),
              h.h1([h.Id(heading.id), h.Class('chapter-title')], [heading.title]),
            ],
          ),
          ...Array.flatMap(cut.opening, (block) => blockOf(block, base, page, model, h)),
        ],
      ),
    ],
  }
}

export const wovenPage = (
  corpus: Corpus,
  root: string,
  base: string,
  openingOf: OpeningOf,
  model: Model,
  h: HtmlBuilder<Message>,
): Html => {
  const slug = model.chapter === '' ? firstSlugOf(corpus) : model.chapter
  return pipe(
    pageOf(corpus, slug),
    Option.orElse(() => Option.fromNullishOr(corpus.pages[0])),
    Option.match({
      onNone: () => h.div([h.Class('docs-page')], []),
      onSome: (page) => {
        const cut = cutOf(page)
        const opening = openingOf(corpus, root, base, page, cut, model, h)
        return h.div(
          [h.Class('docs-page')],
          [
            ...opening.above,
            h.div(
              [h.Class('docs-body')],
              [
                menu(corpus, page, cut, model.activeSection, base, opening.menuMark, h),
                h.article(
                  [h.Class('docs-article')],
                  [
                    ...opening.lead,
                    ...Array.map(cut.sections, (section, place) =>
                      sectionOf(
                        opening.markOf(section, place),
                        section,
                        base,
                        page,
                        model,
                        h,
                      ),
                    ),
                    chapterPager(corpus, base, page, opening.cardMark, h),
                  ],
                ),
              ],
            ),
            scrim(model.drawerOpen, h),
            drawer(corpus, base, page, cut, model, opening.menuMark, h),
          ],
        )
      },
    }),
  )
}

export const documentationPage = (model: Model, h: HtmlBuilder<Message>): Html =>
  wovenPage(docsCorpus, 'Docs', '/docs', docsOpening, model, h)

const emptyCorpus: Corpus = { nav: [], pages: [] }

export const sourcePage = (model: Model, h: HtmlBuilder<Message>): Html =>
  wovenPage(
    Option.getOrElse(model.book, () => emptyCorpus),
    'Source',
    '/source',
    sourceOpening,
    model,
    h,
  )
