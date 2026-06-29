import { describe, expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { FrameRunner } from '#ast/FrameRunner'

// The runner executes a corpus of frames to produce the de re. These fixtures are
// hand-written in the new @athrio/loom-lang/dsl contract (positioned constructors, a __services
// map for wiring, a __run manifest), as FrameAstBuilder will emit. The test proves the
// runner in real code before the emitter is revised: refer by origin, a private
// (unexported) section collected, the corpus layer wired dependency-first, and a
// tangle sink composed to a File.

const POS = '{start:{line:1,column:0,offset:0},end:{line:1,column:1,offset:1}}'

const frameB = `
import * as dsl from "@athrio/loom-lang/dsl"
import { Effect, Layer } from "effect"
export class Mul extends Effect.Service<Mul>()("/b.loom#Mul", {
  succeed: {
    name: \`Mul\`,
    code: dsl.compose({path:"/b.loom",name:"Mul"}, "typescript", dsl.fragment(\`const mul = (a,b) => a*b\`, ${POS})),
    prose: dsl.weave({path:"/b.loom",name:"Mul"})
  }
}) {}
export const __services = { Mul: { layer: Mul.Default, self: Mul, deps: [] } }
export const __run = Effect.gen(function* () {
  return { sections: new Map([["Mul", (yield* Mul).code]]), prose: new Map([["Mul", (yield* Mul).prose]]), files: [] }
})
`

const frameA = `
import * as dsl from "@athrio/loom-lang/dsl"
import { Effect, Layer } from "effect"
import { Mul } from "./b.loom"
class Helper extends Effect.Service<Helper>()("/a.loom#Helper", {
  succeed: {
    name: \`Helper\`,
    code: dsl.compose({path:"/a.loom",name:"Helper"}, "typescript", dsl.fragment(\`const helper = 1\`, ${POS})),
    prose: dsl.weave({path:"/a.loom",name:"Helper"})
  }
}) {}
export class Sq extends Effect.Service<Sq>()("/a.loom#Sq", {
  effect: Effect.gen(function* () {
    const m = yield* Mul
    const _Helper = yield* Helper
    return {
      name: \`Sq\`,
      code: dsl.compose({path:"/a.loom",name:"Sq"}, "typescript",
        dsl.referName(m.code, ${POS}),
        dsl.referName(_Helper.code, ${POS}),
        dsl.fragment(\`const sq = (x) => mul(x,x)\`, ${POS})
      ),
      prose: dsl.weave({path:"/a.loom",name:"Sq"})
    }
  })
}) {}
class WriteSq extends Effect.Service<WriteSq>()("/a.loom#WriteSq", {
  effect: Effect.gen(function* () {
    const s = yield* Sq
    return dsl.tangle("out/sq.ts", s.code)
  })
}) {}
export const __services = {
  Helper: { layer: Helper.Default, self: Helper, deps: [] },
  Sq: { layer: Sq.Default, self: Sq, deps: [Mul, Helper] },
  WriteSq: { layer: WriteSq.Default, self: WriteSq, deps: [Sq] }
}
export const __run = Effect.gen(function* () {
  return {
    sections: new Map([["Helper", (yield* Helper).code], ["Sq", (yield* Sq).code]]),
    prose: new Map([["Helper", (yield* Helper).prose], ["Sq", (yield* Sq).prose]]),
    files: [yield* WriteSq]
  }
})
`

describe('FrameRunner', () => {
  it('runs the corpus: cross-file refer by origin, private section, wired sink', () => {
    const out = Effect.runSync(
      Effect.gen(function* () {
        const runner = yield* FrameRunner
        return yield* runner.produce(
          new Map([
            ['/a.loom', frameA],
            ['/b.loom', frameB],
          ]),
        )
      }).pipe(Effect.provide(FrameRunner.Default)),
    )

    const a = out.get('/a.loom')!
    const codeAt = (name: string) => a.code.find((c) => c.origin.name === name)
    const sq = codeAt('Sq')!
    expect(sq.fragments.map((p) => p.type)).toEqual(['NameRef', 'NameRef', 'Fragment'])
    // refer captured each target's identity (by origin), never its parts
    expect(Option.getOrNull((sq.fragments[0] as any).target)).toEqual({ path: '/b.loom', name: 'Mul' })
    expect(Option.getOrNull((sq.fragments[1] as any).target)).toEqual({ path: '/a.loom', name: 'Helper' })

    // the private section was collected through the in-module manifest
    expect(codeAt('Helper')).toBeDefined()
    expect(out.get('/b.loom')!.code.some((c) => c.origin.name === 'Mul')).toBe(true)

    // the tangle sink composed to a pure descriptor bound to Sq's code, in a.loom's product
    expect(a.files).toHaveLength(1)
    expect(a.files[0].path).toBe('out/sq.ts')
    expect(a.files[0].type).toBe('File')
    expect(a.files[0].code.origin).toEqual({ path: '/a.loom', name: 'Sq' })
  })
})
