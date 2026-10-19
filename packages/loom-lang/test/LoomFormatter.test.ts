import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Array, Effect, Layer, Option } from 'effect'
import { LoomFormatter } from '../src/LoomFormatter'
import { PackageConfig } from '../src/PackageConfig'
import {
  defineLanguageService,
  type LanguageService,
  ServiceError,
} from '@athrio/loom-lang-services/LanguageService'

const it = effectify(it_)

const lines = (...rows: ReadonlyArray<string>): string => `${rows.join('\n')}\n`

const anchor = (name: string): string => `::${'['}${name}]`

const path = '/nowhere/formatted.loom'

const squeezeAt = (width: number): LanguageService =>
  defineLanguageService({
    id: 'typescript',
    displayName: 'Squeeze',
    extensions: ['.ts'],
    plugins: () => Effect.succeed([]),
    format: (request) =>
      Effect.succeed(
        request.width === width ? request.code.replace(/(\S) {2,}(?=\S)/g, '$1 ') : request.code,
      ),
  })

const formatterOf = (format: (code: string) => Option.Option<string>): LanguageService =>
  defineLanguageService({
    id: 'typescript',
    displayName: 'Stand-in',
    extensions: ['.ts'],
    plugins: () => Effect.succeed([]),
    format: (request) =>
      Option.match(format(request.code), {
        onNone: () => Effect.fail(new ServiceError({ service: 'typescript', reason: 'unreadable' })),
        onSome: (code) => Effect.succeed(code),
      }),
  })

const count = (text: string, mark: string): number => text.split(mark).length - 1

const tidy = formatterOf((code) => {
  const rows = Array.map(code.split('\n'), (row) => row.trim().replace(/(\S) {2,}(?=\S)/g, '$1 '))
  const [depth, laid] = Array.mapAccum(rows, 0, (open, row) => {
    const own = row.startsWith('}') ? open - 1 : open
    return [open + count(row, '{') - count(row, '}'), { row, own, open }]
  })
  const holds =
    depth === 0 &&
    Array.every(laid, ({ row, own, open }) => own >= 0 && !(open === 0 && row.endsWith(',')))
  return holds
    ? Option.some(
        Array.map(laid, ({ row, own }) => (row === '' ? '' : '  '.repeat(own) + row)).join('\n'),
      )
    : Option.none()
})

const formatted = (text: string, languages: ReadonlyArray<LanguageService> = []) =>
  LoomFormatter.pipe(
    Effect.flatMap((formatter) => formatter.format(path, text, languages)),
    Effect.provide(LoomFormatter.layer.pipe(Layer.provide(PackageConfig.layer))),
  )

const frontmatter = ['---', 'Language: TypeScript', '---', '']

describe('LoomFormatter — prose', () => {
  it.effect('joins the lines of a paragraph into one', () =>
    Effect.gen(function* () {
      const text = lines(...frontmatter, '# Notes', '', 'One paragraph', 'written over', '   three lines.', '')
      expect(yield* formatted(text)).toBe(
        lines(...frontmatter, '# Notes', '', 'One paragraph written over three lines.', ''),
      )
    }),
  )

  it.effect('keeps the lines of lists, fences, tables and hard breaks', () =>
    Effect.gen(function* () {
      const text = lines(
        ...frontmatter,
        '# Notes',
        '',
        '- an item',
        '  that continues',
        '- the next item',
        '',
        '```',
        'kept',
        'as is',
        '```',
        '',
        '| a | b |',
        '| c | d |',
        '',
        'a break  ',
        'stays',
        '',
      )
      expect(yield* formatted(text)).toBe(
        lines(
          ...frontmatter,
          '# Notes',
          '',
          '- an item that continues',
          '- the next item',
          '',
          '```',
          'kept',
          'as is',
          '```',
          '',
          '| a | b |',
          '| c | d |',
          '',
          'a break  ',
          'stays',
          '',
        ),
      )
    }),
  )

  it.effect('changes nothing twice', () =>
    Effect.gen(function* () {
      const once = yield* formatted(lines(...frontmatter, '# Notes', '', 'Two', 'lines.', ''))
      expect(yield* formatted(once)).toBe(once)
    }),
  )
})

describe('LoomFormatter — code', () => {
  const program = lines(
    ...frontmatter,
    '# Program [program.ts]',
    '',
    'Some prose.',
    '',
    '=>',
    '',
    'const  answer  =  42',
    anchor('Greeting'),
    '',
    '# Greeting',
    '',
    '=>',
    '',
    "console.log('hi',  answer)",
  )

  it.effect('leaves code alone without a formatter for its language', () =>
    Effect.gen(function* () {
      expect(yield* formatted(program)).toBe(program)
    }),
  )

  it.effect('formats each section through its language, in place', () =>
    Effect.gen(function* () {
      expect(yield* formatted(program, [squeezeAt(100)])).toBe(
        program
          .replace('const  answer  =  42', 'const answer = 42')
          .replace("console.log('hi',  answer)", "console.log('hi', answer)"),
      )
    }),
  )

  it.effect('hands the formatter the project width', () =>
    Effect.gen(function* () {
      expect(yield* formatted(program, [squeezeAt(80)])).toBe(program)
    }),
  )

  it.effect('keeps an anchor on a line of its own when the formatter ends lines', () =>
    Effect.gen(function* () {
      const semicolons = formatterOf((code) => Option.some(code.replace(/(\S)$/gm, '$1;')))
      expect(yield* formatted(program, [semicolons])).toBe(
        program
          .replace('const  answer  =  42', 'const  answer  =  42;')
          .replace("console.log('hi',  answer)", "console.log('hi',  answer);"),
      )
    }),
  )

  it.effect('keeps a section as written when its anchor would leave its own line', () =>
    Effect.gen(function* () {
      const joined = formatterOf((code) => Option.some(code.replace(/\n/g, ' ')))
      expect(yield* formatted(program, [joined])).toBe(program)
    }),
  )
})

describe('LoomFormatter — anchors', () => {
  it.effect('gives an anchor its depth, and the section it names its own first column', () =>
    Effect.gen(function* () {
      const nested = (indent: string, body: ReadonlyArray<string>) =>
        lines(
          ...frontmatter,
          '# Main [main.ts]',
          '',
          '=>',
          '',
          'function main() {',
          indent + anchor('Body'),
          '}',
          '',
          '# Body',
          '',
          '=>',
          '',
          ...body,
        )
      expect(
        yield* formatted(nested('', ["  console.log('one')", "  console.log('two')"]), [tidy]),
      ).toBe(nested('  ', ["console.log('one')", "console.log('two')"]))
    }),
  )

  it.effect('formats a shared section once, the same wherever it is used', () =>
    Effect.gen(function* () {
      const shared = (a: string, b: string, body: string) =>
        lines(
          ...frontmatter,
          '# Main [main.ts]',
          '',
          '=>',
          '',
          'function first() {',
          a + anchor('Body'),
          '}',
          'function second() {',
          '  if (ready) {',
          b + anchor('Body'),
          '  }',
          '}',
          '',
          '# Body',
          '',
          '=>',
          '',
          body,
        )
      expect(yield* formatted(shared('', '', "  console.log('go',  now)"), [tidy])).toBe(
        shared('  ', '    ', "console.log('go', now)"),
      )
    }),
  )

  it.effect('keeps the nesting a section opened before its prose', () =>
    Effect.gen(function* () {
      const split = (rows: ReadonlyArray<string>) =>
        lines(
          ...frontmatter,
          '# Main [main.ts]',
          '',
          '=>',
          '',
          rows[0] ?? '',
          rows[1] ?? '',
          '',
          '~',
          '',
          'The work happens once the check passes.',
          '',
          '=>',
          '',
          rows[2] ?? '',
          rows[3] ?? '',
          rows[4] ?? '',
        )
      expect(
        yield* formatted(split(['function main() {', 'if (ready) {', 'run()', '}', '}']), [tidy]),
      ).toBe(split(['function main() {', '  if (ready) {', '    run()', '  }', '}']))
    }),
  )
})

describe('LoomFormatter — sections that need their place', () => {
  const options = (anchors: ReadonlyArray<string>, fields: ReadonlyArray<string>) =>
    lines(
      ...frontmatter,
      '# Options [options.ts]',
      '',
      '=>',
      '',
      ...anchors,
      '',
      '# Fields',
      '',
      '=>',
      '',
      ...fields,
    )

  it.effect('formats a section where its one anchor places it', () =>
    Effect.gen(function* () {
      expect(
        yield* formatted(
          options(['const options = {', anchor('Fields'), '}'], ['retries:  3,', 'verbose:  true,']),
          [tidy],
        ),
      ).toBe(options(['const options = {', `  ${anchor('Fields')}`, '}'], ['retries: 3,', 'verbose: true,']))
    }),
  )

  it.effect('leaves a section that two anchors use as written', () =>
    Effect.gen(function* () {
      const both = (indent: string) => [
        'const first = {',
        indent + anchor('Fields'),
        '}',
        'const second = {',
        indent + anchor('Fields'),
        '}',
      ]
      expect(yield* formatted(options(both(''), ['retries:  3,']), [tidy])).toBe(
        options(both('  '), ['retries:  3,']),
      )
    }),
  )
})
