import { describe, expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { LoomRunner } from '#ast/FrameRunner'

// The runner executes a corpus of frames to produce the de re. These fixtures are
// hand-written in the new @athrio/loom-core contract (positioned constructors, a __services
// map for wiring, a __run manifest), as FrameAstBuilder will emit. The test proves the
// runner in real code before the emitter is revised: cross-file refer by origin, a
// private (tagless) section collected, the corpus layer wired dependency-first, and a
// tangle sink composed to a TangledFile.

const POS = '{start:{line:1,column:0,offset:0},end:{line:1,column:1,offset:1}}'

const frameB = `
import * as core from "@athrio/loom-core"
import { Effect, Layer } from "effect"
export class Mul extends Effect.Service<Mul>()("/b.loom#Mul", {
  succeed: {
    name: \`Mul\`,
    code: core.compose({path:"/b.loom",name:"Mul"}, "typescript", core.fragment(\`const mul = (a,b) => a*b\`, ${POS})),
    prose: core.weave({path:"/b.loom",name:"Mul"})
  }
}) {}
export const __services = { Mul: { layer: Mul.Default, self: Mul, deps: [] } }
export const __run = Effect.gen(function* () {
  return { sections: new Map([["Mul", (yield* Mul).code]]), prose: new Map([["Mul", (yield* Mul).prose]]), files: [] }
})
`

const frameA = `
import * as core from "@athrio/loom-core"
import { Effect, Layer } from "effect"
import { Mul } from "./b.loom"
class Helper extends Effect.Service<Helper>()("/a.loom#Helper", {
  succeed: {
    name: \`Helper\`,
    code: core.compose({path:"/a.loom",name:"Helper"}, "typescript", core.fragment(\`const helper = 1\`, ${POS})),
    prose: core.weave({path:"/a.loom",name:"Helper"})
  }
}) {}
export class Sq extends Effect.Service<Sq>()("/a.loom#Sq", {
  effect: Effect.gen(function* () {
    const m = yield* Mul
    const _Helper = yield* Helper
    return {
      name: \`Sq\`,
      code: core.compose({path:"/a.loom",name:"Sq"}, "typescript",
        core.referTag(m.code, ${POS}),
        core.referName(_Helper.code, ${POS}),
        core.fragment(\`const sq = (x) => mul(x,x)\`, ${POS})
      ),
      prose: core.weave({path:"/a.loom",name:"Sq"})
    }
  })
}) {}
class WriteSq extends Effect.Service<WriteSq>()("/a.loom#WriteSq", {
  effect: Effect.gen(function* () {
    const s = yield* Sq
    return core.tangle("out/sq.ts", s.code)
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

describe('LoomRunner', () => {
  it('runs the corpus: cross-file refer by origin, private section, wired sink', () => {
    const out = Effect.runSync(
      Effect.gen(function* () {
        const runner = yield* LoomRunner
        return yield* runner.run(
          new Map([
            ['/a.loom', frameA],
            ['/b.loom', frameB],
          ]),
        )
      }).pipe(Effect.provide(LoomRunner.Default)),
    )

    const a = out.code.get('/a.loom')!
    const sq = a.get('Sq')!
    expect(sq.parts.map((p) => p.type)).toEqual(['TagRef', 'NameRef', 'Fragment'])
    // refer captured each target's identity (by origin), never its parts
    expect(Option.getOrNull((sq.parts[0] as any).target)).toEqual({ path: '/b.loom', name: 'Mul' })
    expect(Option.getOrNull((sq.parts[1] as any).target)).toEqual({ path: '/a.loom', name: 'Helper' })

    // the private section was collected through the in-module manifest
    expect(a.has('Helper')).toBe(true)
    expect(out.code.get('/b.loom')!.has('Mul')).toBe(true)

    // the tangle sink composed to a pure descriptor bound to Sq's code
    expect(out.files).toHaveLength(1)
    expect(out.files[0].path).toBe('out/sq.ts')
    expect(out.files[0].type).toBe('TangledFile')
    expect(out.files[0].code.origin).toEqual({ path: '/a.loom', name: 'Sq' })
  })
})
