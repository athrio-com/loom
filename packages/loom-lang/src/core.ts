import { Option } from 'effect'
import { okHealth, type Position } from '#ast/LoomNode'
import type {
  ComposedCode,
  Fragment,
  Part,
  Ref,
  SectionId,
  TangledFile,
  WovenProse,
} from '#ast/ProductAst'

export const fragment = (text: string, origin: Position): Fragment => ({
  type: 'Fragment',
  health: okHealth,
  text,
  origin,
})

export const refer = (
  code: { readonly origin: SectionId },
  anchor: Position,
): Ref => ({
  type: 'Ref',
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
