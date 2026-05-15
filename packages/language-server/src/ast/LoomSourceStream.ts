import { Effect, Schema, Stream } from "effect"
import { FileSystem } from "@effect/platform"
import { PointSchema, type Point } from "./LoomDocument"



// =============================================================================
// SourceLine — line content + the terminator that ended it + start position.
//
// `text`       : line content (terminator-free)
// `terminator` : the bytes consumed after `text` in the original source,
//                or "" for the final line of a source with no trailing EOL
// `startPoint` : position of the first code unit of `text`
//
// Invariant: concatenating `text + terminator` across every SourceLine of a
// source reproduces the original bytes exactly. Nothing is stripped, nothing
// is normalised — the contract LSP needs to round-trip edits faithfully.
//
// Offsets are UTF-16 code units (JavaScript string length), aligning with
// LSP's default `positionEncoding: utf-16`. Encoding negotiation, if any,
// happens at the LSP boundary, not here.
// =============================================================================

export const LineTerminatorSchema = Schema.Literal("\n", "\r\n", "\r", "")
export type LineTerminator = typeof LineTerminatorSchema.Type

export const SourceLineSchema = Schema.Struct({
  text: Schema.String,
  terminator: LineTerminatorSchema,
  startPoint: PointSchema,
})
export type SourceLine = typeof SourceLineSchema.Type

// =============================================================================
// detectEol — pure function: which terminator does this source use?
//
// Real-world sources use one EOL convention throughout (every modern editor
// enforces this on save). We scan once for the first terminator and adopt it
// as the source's convention. A file with mixed terminators would mis-position
// from the second variant onward; that's a malformed-input signal handled
// upstream, not something we silently paper over here.
//
// Returns "" only for sources with no terminator at all — single-line input
// or empty input.
// =============================================================================

export const detectEol = (s: string): LineTerminator => {
  const lf = s.indexOf("\n")
  const cr = s.indexOf("\r")
  if (lf < 0 && cr < 0) return ""
  if (cr < 0) return "\n"
  if (lf < 0) return "\r"
  return cr < lf ? (cr + 1 === lf ? "\r\n" : "\r") : "\n"
}

// =============================================================================
// attachPositions — pure 1:1 transform from line text to SourceLine.
//
// State is a `Point` — the running cursor. `Stream.mapAccum` threads it
// immutably through the pipeline: each step receives the current Point and
// the next line text, returns the next Point plus the emitted SourceLine.
// No reassignment, no closure-captured mutability.
//
// The initial state is the caller's `start` Point, so the very first
// SourceLine carries whatever `start.column` the caller supplied (typically
// undefined or 1). Subsequent state transitions drop `column`: every line
// after the first begins at the start of its own line, where column is 1 by
// definition and need not be stored — downstream consumers compute it from
// offset when they need it (e.g. when translating to an LSP `Position`).
// =============================================================================

const attachPositions =
  (start: Point, terminator: LineTerminator) =>
  <E, R>(lines: Stream.Stream<string, E, R>): Stream.Stream<SourceLine, E, R> =>
    lines.pipe(
      Stream.mapAccum(
        start,
        (state, text) =>
          [
            {
              line: state.line + 1,
              offset: state.offset + text.length + terminator.length,
            } satisfies Point,
            SourceLineSchema.make({
              text,
              terminator,
              startPoint: state,
            }),
          ] as const,
      ),
    )

// =============================================================================
// buildLineStream — internal helper. Combines detect + split + attach so
// fromString and fromFile share one definition.
// =============================================================================

const buildLineStream = (
  source: string,
  start: Point,
): Stream.Stream<SourceLine, never> =>
  Stream.make(source).pipe(
    Stream.splitLines,
    attachPositions(start, detectEol(source)),
  )