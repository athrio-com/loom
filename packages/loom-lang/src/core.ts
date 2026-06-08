import { FileSystem, Path } from '@effect/platform'
import { Effect } from 'effect'

// =============================================================================
// #loom/core — the runtime primitives the generated Frame imports and calls.
//
// Just two functions; everything else in the Frame (Effect, Layer, the Service
// classes) is the author's own composition, never Loom's. They are plain
// functions, not Loom Services: `compose` is pure text assembly, `tangle` is the
// single effectful sink.
//
// A section's composed product — its `code` — is literal text: source code
// concatenated in composition order. A `CodeRef` (`m.code`) is just the `code`
// string of a dependency Service, so composition is string assembly all the way
// down; the Effect machinery never reaches the product, which stays text.
// =============================================================================

// compose — order the code of the sections it references, in argument order,
// into one composed result. Byte-faithful: each fragment already carries its
// own surrounding whitespace (the frame pass split the block at its anchors), so
// the join inserts nothing between parts. A section with no code is `compose()`,
// which is the empty string.
export const compose = (...parts: ReadonlyArray<string>): string =>
  parts.join('')

// tangle — bind a composed result to a file path. Running it at the end of the
// world emits the file, creating parent directories as needed. The emitted path
// is returned so a runtime can report what it wrote.
export const tangle = (path: string, code: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const p = yield* Path.Path
    yield* fs.makeDirectory(p.dirname(path), { recursive: true })
    yield* fs.writeFileString(path, code)
    return path
  })
