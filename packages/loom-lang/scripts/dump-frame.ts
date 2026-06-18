import { NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LoomCorpusAstBuilder, type Source } from '#ast/LoomCorpusAstBuilder'
import {
  fromFrame,
  fromProduct,
  type CodeByPath,
} from '#ast/LoomVirtualCodeBuilder'

// =============================================================================
// dump-frame — dev probe. Reads a `.loom`, runs LoomCorpusAstBuilder (read →
// parse → frame → de re `code`) then fromFrame + fromProduct, and prints (1)
// the frame source mappings as `gen ⟵ src` pairs (a `name` mapped to an empty
// source span flagged), (2) the resolved de re product documents (one per
// Service, transclusions inlined), and (3) the full `FrameModule` as JSON
// (health omitted, `position` compacted to offsets).
//
//   pnpm tsx scripts/dump-frame.ts [path/to/file.loom]   (default: experimental.loom)
// =============================================================================

const path = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(__dirname, './experimental.loom')
const text = readFileSync(path, 'utf8')

const q = (s: string) => JSON.stringify(s)

const compact = (k: string, v: any) => {
  if (k === 'health') return undefined
  if (k === 'position' && v && 'start' in v) {
    return `${v.start.offset}..${v.end.offset}`
  }
  return v
}

const source: Source = { read: () => Effect.succeed(text) }

const program = Effect.gen(function* () {
  const builder = yield* LoomCorpusAstBuilder
  const { frame, code } = yield* builder.build(source, '')
  const { code: genCode, mappings } = fromFrame(frame)
  const codeByPath: CodeByPath = new Map([['', code]])
  const products = [...code.values()].map((node) => {
    const vc = fromProduct(codeByPath, node.origin)
    return { id: vc.id, languageId: vc.languageId, code: vc.code }
  })

  const rows = mappings
    .map((m) => {
      const gen = genCode.slice(m.genStart, m.genStart + m.genLength)
      const src = text.slice(m.source.start.offset, m.source.end.offset)
      // A `name` must map to a real label/name span, or be synth (unmapped) — a
      // name mapped to an empty span is the anomaly (e.g. a tagless hash leaking
      // back in). A by-name anchor's name legitimately differs in *text* from its
      // label, so text-difference alone is not flagged.
      const warn =
        m.kind === 'name' && m.source.start.offset === m.source.end.offset
          ? '  ⚠ NAME→∅'
          : ''
      const gp = `gen[${m.genStart},${m.genStart + m.genLength})`
      const sp = `src[${m.source.start.offset},${m.source.end.offset})`
      return `[${(m.kind ?? 'code').padEnd(10)}] ${gp} ${q(gen)} ⟵ ${sp} ${q(src)}${warn}`
    })
    .join('\n')

  process.stdout.write(`// ===== Mappings (${mappings.length}) — gen ⟵ src =====\n`)
  process.stdout.write(rows + '\n\n')

  const docs = products
    .map((p) => `// --- ${p.id}  (${p.languageId}) ---\n${p.code}`)
    .join('\n')
  process.stdout.write(
    `// ===== Resolved product documents (${products.length}) — de re =====\n`,
  )
  process.stdout.write(docs + '\n\n')

  process.stdout.write(
    '// ===== FrameModule (JSON; health omitted, position as offsets) =====\n',
  )
  process.stdout.write(JSON.stringify(frame, compact, 2) + '\n')
}).pipe(Effect.provide(LoomCorpusAstBuilder.Default))

NodeRuntime.runMain(program)
