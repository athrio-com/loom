import { Effect, Option, Stream, Data, Schema } from "effect"

// =============================================================================
// EolKind — the line terminator convention of a source file.
//   "lf"   → \n      (Unix)
//   "crlf" → \r\n    (Windows)
//   "cr"   → \r      (classic Mac)
// =============================================================================

export type EolKind = "lf" | "crlf" | "cr"

// =============================================================================
// Eol — detected convention plus the regexes used to walk and validate it.
//
//   pattern — matches the convention's terminator (with `g` flag), used by
//             the unfold to find the next line break.
//   stray   — matches any terminator that does NOT belong to the convention,
//             used by checkMixed to detect mixed EOL.
// =============================================================================

type Eol = {
  readonly kind: EolKind
  readonly pattern: RegExp
  readonly stray: RegExp
}

// =============================================================================
// MixedEOL — error raised when a source file contains more than one kind of
// line terminator. Mixed terminators are invisible to the reader, so the
// error carries human-friendly line numbers (primary kind first seen on
// `primaryLine`; offending kind first seen on `foundLine`) for use directly
// in diagnostic messages. The offset of the offending terminator is also
// available for callers that need it.
//
// `primary` and `found` are tag strings ("lf" | "crlf" | "cr"), suitable for
// direct display.
// =============================================================================

export class MixedEOL extends Data.TaggedError("MixedEOL")<{
  readonly primary: EolKind
  readonly found: EolKind
  readonly offset: number
  readonly primaryLine: number
  readonly foundLine: number
}> { }

// =============================================================================
// detectEol — which terminator convention does this source use?
//
// Scans once for the first terminator and adopts it as the file's convention.
// Returns None for single-line input (no terminators at all).
// =============================================================================

export const detectEol = (s: string): Option.Option<Eol> => {
  const lf = s.indexOf("\n")
  const cr = s.indexOf("\r")
  if (lf < 0 && cr < 0) return Option.none()
  if (cr < 0) return Option.some(eolOf("lf"))
  if (lf < 0) return Option.some(eolOf("cr"))
  return cr < lf
    ? cr + 1 === lf
      ? Option.some(eolOf("crlf"))
      : Option.some(eolOf("cr"))
    : Option.some(eolOf("lf"))
}

const eolOf = (kind: EolKind): Eol => {
  switch (kind) {
    case "lf":
      return { kind, pattern: /\n/g, stray: /\r/g }
    case "crlf":
      return { kind, pattern: /\r\n/g, stray: /(?<!\r)\n|\r(?!\n)/g }
    case "cr":
      return { kind, pattern: /\r/g, stray: /\n/g }
  }
}

// =============================================================================
// checkMixed — verify the source uses a single terminator throughout.
//
// After detecting the primary convention, scans for the presence of any
// other terminator kind. Succeeds with the Eol if the file is consistent;
// fails with MixedEOL otherwise.
// =============================================================================

const checkMixed = (text: string, eol: Eol): Effect.Effect<Eol, MixedEOL> => {
  const stray = eol.stray.exec(text)
  if (!stray) return Effect.succeed(eol)
  eol.pattern.lastIndex = 0
  const primary = eol.pattern.exec(text)
  const primaryOffset = primary ? primary.index : 0
  return Effect.fail(new MixedEOL({
    primary: eol.kind,
    found: strayKind(eol.kind, stray[0]),
    offset: stray.index,
    primaryLine: lineOfOffset(text, primaryOffset),
    foundLine: lineOfOffset(text, stray.index),
  }))
}

// =============================================================================
// lineOfOffset — counts visual lines from text start to `offset`. Treats any
// terminator (LF, CRLF, CR) as a single line break, so it gives the right
// answer even when terminators are mixed (which is exactly the case we
// surface diagnostics for).
// =============================================================================

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
  if (match === "\r\n") return "crlf"
  if (match === "\n") return "lf"
  if (match === "\r") return "cr"
  // Unreachable: `stray` regex only matches one of \n, \r, or \r\n.
  return primary
}

// =============================================================================
// LineRange — a half-open [start, end) byte range into the source text.
//
// Includes the terminator: `text.slice(start, end)` gives the full line with
// its EOL bytes. Content without terminator is `text.slice(start, end - eolLen)`
// where `eolLen` is the detected convention's length.
//
// Every offset is directly usable as `sourceOffsets` in Volar CodeMappings —
// no translation step between the scanner output and the mapping input.
// =============================================================================

export type LineRange = readonly [start: number, end: number]

// =============================================================================
// LineRangeSchema — Schema mirror of the LineRange tuple, for use as a field
// in schema-based ADTs (Wefts, syntax-tree nodes). Both elements are
// non-negative integers; `end >= start` is invariant of the producer and not
// re-checked at the schema boundary.
// =============================================================================

const NonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

export const LineRangeSchema = Schema.Tuple(NonNegativeInt, NonNegativeInt)

// =============================================================================
// lineRanges — streams half-open [start, end) ranges by walking the source
// with a pre-detected EOL regex. Uses Stream.unfold: each step sets
// `eol.pattern.lastIndex`, calls `exec`, and emits the range from the current
// position to the end of the matched terminator. The last line (no trailing
// terminator) emits [from, text.length].
// =============================================================================

const lineRanges = (text: string, eol: Eol): Stream.Stream<LineRange> =>
  Stream.unfold(0, (from) => {
    if (from > text.length) return Option.none()
    eol.pattern.lastIndex = from
    const m = eol.pattern.exec(text)
    if (!m) return Option.some([[from, text.length] as const, text.length + 1])
    return Option.some([[from, eol.pattern.lastIndex] as const, eol.pattern.lastIndex])
  })

// =============================================================================
// LoomSourceRanges — Effect Service: source text → Stream<LineRange>.
//
// Detects the EOL convention once, verifies consistency (fails with MixedEOL
// if the file mixes terminators), then streams offset ranges. Single-line
// input (no terminator detected) emits one range covering the full text.
//
// The original source string is never split or copied — downstream stages
// receive numeric ranges and slice on demand when they need to inspect
// content (checking for `## `, `=>`, `~~~`, etc.).
// =============================================================================

export class LoomSourceRanges extends Effect.Service<LoomSourceRanges>()(
  "LoomSourceRanges",
  {
    succeed: {
      stream: (text: string): Effect.Effect<Stream.Stream<LineRange>, MixedEOL> =>
        Option.match(detectEol(text), {
          onNone: () => Effect.succeed(Stream.make([0, text.length] as const)),
          onSome: (eol) =>
            checkMixed(text, eol).pipe(
              Effect.map((validEol) => lineRanges(text, validEol)),
            ),
        }),
    },
  },
) { }
