import { Option } from 'effect'
import { okHealth, type Position } from '@athrio/loom-ast/LoomNode'
import type {
  Code,
  File,
  Fragment,
  NameRef,
  Part,
  SectionId,
  WovenProse,
} from '@athrio/loom-ast/ProductAst'

export const fragment = (text: string, origin: Position): Fragment => ({
  type: 'Fragment',
  health: okHealth,
  text,
  origin,
})

export const referValue = (value: unknown, anchor: Position): Fragment => ({
  type: 'Fragment',
  health: okHealth,
  text: String(value),
  origin: anchor,
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

export const compose = (
  origin: SectionId,
  languageId: string,
  ...fragments: ReadonlyArray<Part>
): Code => ({
  type: 'Code',
  health: okHealth,
  origin,
  languageId,
  fragments,
})

export const weave = (
  origin: SectionId,
  ...fragments: ReadonlyArray<Part>
): WovenProse => ({
  type: 'WovenProse',
  health: okHealth,
  origin,
  fragments,
})

export const tangle = (path: string, code: Code): File => ({
  type: 'File',
  health: okHealth,
  path,
  code,
})
