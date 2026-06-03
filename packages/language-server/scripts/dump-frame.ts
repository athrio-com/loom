import { NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Loom } from '#ast/Loom'
import { Resolver } from '#projectors/Resolver'
import { Synthesiser } from '#projectors/Synthesiser'
import { Transducer } from '#projectors/Transducer'

// =============================================================================
// dump-frame — dev probe. Reads a `.loom`, runs parse → transduce → synthesise →
// resolve, and prints (1) the frame source mappings as `gen ⟵ src` pairs
// (identifier mismatches flagged), (2) the resolved de re product documents (one
// per Service, transclusions inlined), and (3) the full `FrameModule` as JSON
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

const program = Effect.gen(function* () {
  const loom = yield* Loom
  const transducer = yield* Transducer
  const synthesiser = yield* Synthesiser
  const resolver = yield* Resolver

  const document = yield* loom.ast(text)
  const frame = yield* transducer.run(document)
  const { genCode, mappings } = yield* synthesiser.run(frame)
  const products = yield* resolver.run(frame, text)

  const rows = mappings
    .map((m) => {
      const gen = genCode.slice(m.genStart, m.genStart + m.genLength)
      const src = text.slice(m.source.start.offset, m.source.end.offset)
      const warn = m.kind === 'identifier' && gen !== src ? '  ⚠ MISMATCH' : ''
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
}).pipe(
  Effect.provide(Loom.Default),
  Effect.provide(Transducer.Default),
  Effect.provide(Synthesiser.Default),
  Effect.provide(Resolver.Default),
)

NodeRuntime.runMain(program)
