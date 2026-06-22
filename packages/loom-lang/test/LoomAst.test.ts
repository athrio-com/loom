import { describe, expect, it } from '@effect/vitest'
import { Schema } from 'effect'
import {
  LoomDocumentSchema,
  LoomHeadingSchema,
  LoomSectionSchema,
} from '#ast/LoomAst'
import { okHealth, type Position } from '@athrio/loom-core/LoomNode'

const pos: Position = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 4, offset: 3 },
}

// Synthetic test fixtures — no real source bytes, so every node carries
// `source: ""`. The schemas accept any string here; "" simply signals "no
// underlying text" for these manually-constructed objects.
const src = ''

const headingStart = {
  type: 'HeadingStart' as const,
  position: pos,
  source: src,
  health: okHealth,
}

const title = (value: string) => ({
  type: 'HeadingTitle' as const,
  position: pos,
  source: value,
  health: okHealth,
})

const tag = (label: string) => ({
  type: 'Tag' as const,
  position: pos,
  source: src,
  health: okHealth,
  open: {
    type: 'TagOpen' as const,
    value: '[' as const,
    position: pos,
    source: src,
    health: okHealth,
  },
  label: {
    type: 'TagLabel' as const,
    value: label,
    position: pos,
    source: src,
    health: okHealth,
  },
  close: {
    type: 'TagClose' as const,
    value: ']' as const,
    position: pos,
    source: src,
    health: okHealth,
  },
})

const specifier = (label: string) => ({
  type: 'Specifier' as const,
  position: pos,
  source: src,
  health: okHealth,
  open: {
    type: 'SpecifierOpen' as const,
    value: '{' as const,
    position: pos,
    source: src,
    health: okHealth,
  },
  label: {
    type: 'SpecifierLabel' as const,
    value: label,
    position: pos,
    source: src,
    health: okHealth,
  },
  close: {
    type: 'SpecifierClose' as const,
    value: '}' as const,
    position: pos,
    source: src,
    health: okHealth,
  },
})

// =============================================================================
// LoomHeading — one shape for every heading level.
//
// `headingStart` is the single heading-start token (HeadingStartTokenSchema).
// `title` is the optional single HeadingTitle token.
// `tag` and `specifier` are both optional.
// =============================================================================

describe('LoomHeading.headingStart', () => {
  it('accepts a heading built with headingStart field', () => {
    expect(
      Schema.is(LoomHeadingSchema)({
        type: 'LoomHeading',
        position: pos,
        source: src,
        health: okHealth,
        headingStart,
        tag: tag('Loom'),
        specifier: specifier('Loom'),
      }),
    ).toBe(true)
  })

  it('rejects a heading whose headingStart has the wrong type discriminator', () => {
    expect(
      Schema.is(LoomHeadingSchema)({
        type: 'LoomHeading',
        position: pos,
        source: src,
        health: okHealth,
        headingStart: { ...headingStart, type: 'Arrow' },
      }),
    ).toBe(false)
  })
})

describe('LoomHeading.title', () => {
  it('accepts a heading with no title (opens straight into a tag)', () => {
    expect(
      Schema.is(LoomHeadingSchema)({
        type: 'LoomHeading',
        position: pos,
        source: src,
        health: okHealth,
        headingStart,
        tag: tag('Loom'),
      }),
    ).toBe(true)
  })

  it('accepts a heading carrying a single title token', () => {
    expect(
      Schema.is(LoomHeadingSchema)({
        type: 'LoomHeading',
        position: pos,
        source: src,
        health: okHealth,
        headingStart,
        title: title('Section title'),
        tag: tag('Loom'),
      }),
    ).toBe(true)
  })

  it('rejects a wrong-kind token in the `title` slot', () => {
    expect(
      Schema.is(LoomHeadingSchema)({
        type: 'LoomHeading',
        position: pos,
        source: src,
        health: okHealth,
        headingStart,
        // a Tag is the wrong kind here
        title: tag('Greet') as unknown as ReturnType<typeof title>,
      }),
    ).toBe(false)
  })
})

// =============================================================================
// LoomDocument — two slots: preamble (PreambleWeft[]) and sections
// (LoomSection[]). There is NO `wefts` slot and NO `chapters` slot.
// Either slot may be empty.
// =============================================================================

const preambleWeft = () => ({
  type: 'PreambleWeft' as const,
  position: pos,
  source: src,
  health: okHealth,
  warps: [],
})

const heading = () => ({
  type: 'LoomHeading' as const,
  position: pos,
  source: src,
  health: okHealth,
  headingStart,
})

const section = () => ({
  type: 'LoomSection' as const,
  position: pos,
  source: src,
  health: okHealth,
  heading: heading(),
  preamble: [],
  code: [],
})

describe('LoomDocument', () => {
  it('accepts an empty document (both slots empty)', () => {
    expect(
      Schema.is(LoomDocumentSchema)({
        type: 'LoomDocument',
        position: pos,
        source: src,
        health: okHealth,
        preamble: [],
        sections: [],
      }),
    ).toBe(true)
  })

  it('accepts PreambleWefts in `preamble`', () => {
    expect(
      Schema.is(LoomDocumentSchema)({
        type: 'LoomDocument',
        position: pos,
        source: src,
        health: okHealth,
        preamble: [preambleWeft(), preambleWeft()],
        sections: [],
      }),
    ).toBe(true)
  })

  it('accepts LoomSections in `sections`', () => {
    expect(
      Schema.is(LoomDocumentSchema)({
        type: 'LoomDocument',
        position: pos,
        source: src,
        health: okHealth,
        preamble: [],
        sections: [section()],
      }),
    ).toBe(true)
  })

  it('rejects a non-PreambleWeft (e.g. a bare object with wrong type) in `preamble`', () => {
    expect(
      Schema.is(LoomDocumentSchema)({
        type: 'LoomDocument',
        position: pos,
        source: src,
        health: okHealth,
        preamble: [{ type: 'ProseWeft', position: pos, health: okHealth }],
        sections: [],
      }),
    ).toBe(false)
  })

  it('rejects a non-Section (e.g. an object with no heading) in `sections`', () => {
    expect(
      Schema.is(LoomDocumentSchema)({
        type: 'LoomDocument',
        position: pos,
        source: src,
        health: okHealth,
        preamble: [],
        sections: [{ type: 'LoomSection', position: pos, health: okHealth }],
      }),
    ).toBe(false)
  })

  it('rejects a document with the old three-slot shape (wefts/sections/chapters)', () => {
    expect(
      Schema.is(LoomDocumentSchema)({
        type: 'LoomDocument',
        position: pos,
        source: src,
        health: okHealth,
        wefts: [],
        sections: [],
        chapters: [],
      }),
    ).toBe(false)
  })
})

// =============================================================================
// LoomSection — quick sanity checks for the body slots.
// =============================================================================

describe('LoomSection — body shape', () => {
  it('accepts heading + empty preamble + empty code', () => {
    expect(Schema.is(LoomSectionSchema)(section())).toBe(true)
  })

  it('accepts a section with preamble wefts', () => {
    expect(
      Schema.is(LoomSectionSchema)({
        ...section(),
        preamble: [preambleWeft()],
      }),
    ).toBe(true)
  })

  it('rejects a section without a heading', () => {
    expect(
      Schema.is(LoomSectionSchema)({
        type: 'LoomSection',
        position: pos,
        health: okHealth,
        preamble: [],
        code: [],
      }),
    ).toBe(false)
  })
})
