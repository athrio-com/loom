import { Array } from 'effect'
import { html, type Html } from 'foldkit/html'

export type TokenKind =
  | 'keyword'
  | 'type'
  | 'string'
  | 'number'
  | 'comment'
  | 'punctuation'
  | 'function'
  | 'operator'
  | 'anchor'
  | 'prose'
  | 'heading'
  | 'plain'

export type Token = { text: string; kind: TokenKind }
export type Line = ReadonlyArray<Token>

const h = html()

const tokenView = (token: Token): Html =>
  h.span([h.Class(`loom-tok-${token.kind}`)], [token.text])

const lineView = (line: Line): Html =>
  h.div([h.Class('loom-code-line')], Array.map(line, tokenView))

export const codeBlock = (props: { lines: ReadonlyArray<Line> }): Html =>
  h.pre([h.Class('loom-code')], Array.map(props.lines, lineView))
