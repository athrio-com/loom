import { Option } from 'effect'
import { okHealth, type Position } from '#ast/LoomNode'
import type {
  ComposedCode,
  Fragment,
  NameRef,
  Part,
  SectionId,
  TagRef,
  TangledFile,
  WovenProse,
} from '#ast/ProductAst'

export const fragment = (text: string, origin: Position): Fragment => ({
  type: 'Fragment',
  health: okHealth,
  text,
  origin,
})

export const referName = (
  code: { readonly origin: SectionId },
  anchor: Position,
): NameRef => ({
  type: 'NameRef',
  health: okHealth,
  target: Option.some(code.origin),
  anchor,
})

export const referTag = (
  code: { readonly origin: SectionId },
  anchor: Position,
): TagRef => ({
  type: 'TagRef',
  health: okHealth,
  target: Option.some(code.origin),
  anchor,
})

export const compose = (
  origin: SectionId,
  languageId: string,
  ...parts: ReadonlyArray<Part>
): ComposedCode => ({
  type: 'ComposedCode',
  health: okHealth,
  origin,
  languageId,
  parts,
})

export const weave = (
  origin: SectionId,
  ...parts: ReadonlyArray<Part>
): WovenProse => ({
  type: 'WovenProse',
  health: okHealth,
  origin,
  parts,
})

export const tangle = (path: string, code: ComposedCode): TangledFile => ({
  type: 'TangledFile',
  health: okHealth,
  path,
  code,
})
