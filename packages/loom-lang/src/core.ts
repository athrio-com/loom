import { FileSystem, Path } from '@effect/platform'
import { Effect } from 'effect'

export const compose = (...parts: ReadonlyArray<string>): string =>
  parts.join('')

export const weave = (...parts: ReadonlyArray<string>): string =>
  parts.join('')

export const tangle = (path: string, code: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const p = yield* Path.Path
    yield* fs.makeDirectory(p.dirname(path), { recursive: true })
    yield* fs.writeFileString(path, code)
    return path
  })
