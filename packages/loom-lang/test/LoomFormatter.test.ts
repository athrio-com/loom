import { describe, expect, it as it_ } from 'bun:test'
import { effectify } from '@athrio/effect-test'
import { Effect, Layer } from 'effect'
import { LoomFormatter } from '../src/LoomFormatter'
import { PackageConfig } from '../src/PackageConfig'
import { defineLanguageService, type LanguageService } from '@athrio/loom-lang-services/LanguageService'

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
        request.width === width
          ? request.code.replace(/(\S) {2,}(?=\S)/g, '$1 ')
          : request.code,
      ),
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
        lines(
          ...frontmatter,
          '# Program [program.ts]',
          '',
          'Some prose.',
          '',
          '=>',
          '',
          'const answer = 42',
          anchor('Greeting'),
          '',
          '# Greeting',
          '',
          '=>',
          '',
          "console.log('hi', answer)",
        ),
      )
    }),
  )

  const formatterOf = (format: (code: string) => string): LanguageService =>
    defineLanguageService({
      id: 'typescript',
      displayName: 'Stand-in',
      extensions: ['.ts'],
      plugins: () => Effect.succeed([]),
      format: (request) => Effect.succeed(format(request.code)),
    })

  it.effect('lands a closing semicolon at the end of the section before it', () =>
    Effect.gen(function* () {
      const semicolons = formatterOf((code) => code.replace(/(\S)\n/g, '$1;\n'))
      expect(yield* formatted(program, [semicolons])).toBe(
        program
          .replace('const  answer  =  42\n', 'const  answer  =  42;\n')
          .replace("console.log('hi',  answer)\n", "console.log('hi',  answer);\n"),
      )
    }),
  )

  it.effect('leaves a root whose change has nowhere to land', () =>
    Effect.gen(function* () {
      const voided = formatterOf((code) =>
        code.replace(/(\S) {2,}(?=\S)/g, '$1 ').replace(/^console/m, 'void console'),
      )
      expect(yield* formatted(program, [voided])).toBe(program)
    }),
  )

  it.effect('hands the formatter the project width', () =>
    Effect.gen(function* () {
      expect(yield* formatted(program, [squeezeAt(80)])).toBe(program)
    }),
  )
})
