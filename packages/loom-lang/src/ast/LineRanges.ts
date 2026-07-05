import { Context, Effect, Layer, Option, Stream, Data, Schema } from 'effect'

export type EolKind = 'lf' | 'crlf' | 'cr'

type Eol = {
  readonly kind: EolKind
  readonly pattern: RegExp
  readonly stray: RegExp
}

export class MixedEOL extends Data.TaggedError('MixedEOL')<{
  readonly primary: EolKind
  readonly found: EolKind
  readonly offset: number
  readonly primaryLine: number
  readonly foundLine: number
}> {}

export const detectEol = (s: string): Option.Option<Eol> => {
  const lf = s.indexOf('\n')
  const cr = s.indexOf('\r')
  if (lf < 0 && cr < 0) return Option.none()
  if (cr < 0) return Option.some(eolOf('lf'))
  if (lf < 0) return Option.some(eolOf('cr'))
  return cr < lf
    ? cr + 1 === lf
      ? Option.some(eolOf('crlf'))
      : Option.some(eolOf('cr'))
    : Option.some(eolOf('lf'))
}

const eolOf = (kind: EolKind): Eol => {
  switch (kind) {
    case 'lf':
      return { kind, pattern: /\n/g, stray: /\r/g }
    case 'crlf':
      return { kind, pattern: /\r\n/g, stray: /(?<!\r)\n|\r(?!\n)/g }
    case 'cr':
      return { kind, pattern: /\r/g, stray: /\n/g }
  }
}

const checkMixed = (text: string, eol: Eol): Effect.Effect<Eol, MixedEOL> => {
  const stray = eol.stray.exec(text)
  if (!stray) return Effect.succeed(eol)
  eol.pattern.lastIndex = 0
  const primary = eol.pattern.exec(text)
  const primaryOffset = primary ? primary.index : 0
  return Effect.fail(
    new MixedEOL({
      primary: eol.kind,
      found: strayKind(eol.kind, stray[0]),
      offset: stray.index,
      primaryLine: lineOfOffset(text, primaryOffset),
      foundLine: lineOfOffset(text, stray.index),
    }),
  )
}

const lineOfOffset = (text: string, offset: number): number => {
  let line = 1
  for (let i = 0; i < offset; i++) {
    const c = text.charCodeAt(i)
    if (c === 10) line++
    else if (c === 13) {
      line++
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) i++
    }
  }
  return line
}

const strayKind = (primary: EolKind, match: string): EolKind => {
  if (match === '\r\n') return 'crlf'
  if (match === '\n') return 'lf'
  if (match === '\r') return 'cr'
  return primary
}

export type LineRange = readonly [start: number, end: number]

const NonNegativeInt = Schema.Number.check(
  Schema.makeFilter<number>((n) =>
    Number.isInteger(n) && n >= 0 ? undefined : 'must be a non-negative integer',
  ),
)

export const LineRangeSchema = Schema.Tuple([NonNegativeInt, NonNegativeInt])

const lineRanges = (text: string, eol: Eol): Stream.Stream<LineRange> =>
  Stream.unfold(0, (from) =>
    Effect.sync(() => {
      if (from > text.length) return undefined
      eol.pattern.lastIndex = from
      const m = eol.pattern.exec(text)
      if (!m) return [[from, text.length], text.length + 1] as const
      return [[from, eol.pattern.lastIndex], eol.pattern.lastIndex] as const
    }),
  )

export class LoomSourceRanges extends Context.Service<LoomSourceRanges>()(
  'LoomSourceRanges',
  {
    make: Effect.succeed({
      stream: (
        text: string,
      ): Effect.Effect<Stream.Stream<LineRange>, MixedEOL> =>
        Option.match(detectEol(text), {
          onNone: () => Effect.succeed(Stream.make([0, text.length] as const)),
          onSome: (eol) =>
            checkMixed(text, eol).pipe(
              Effect.map((validEol) => lineRanges(text, validEol)),
            ),
        }),
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}
