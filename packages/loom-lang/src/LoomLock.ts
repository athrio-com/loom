import { Array, Order, Schema, pipe } from 'effect'

export const LoomLockSchema = Schema.Struct({
  version: Schema.Literal(1),
  tangled: Schema.Array(Schema.String),
})

export type LoomLock = typeof LoomLockSchema.Type

export const emptyLock: LoomLock = { version: 1, tangled: [] }

export const orphansOf = (
  lock: LoomLock,
  produced: ReadonlySet<string>,
): ReadonlyArray<string> =>
  Array.filter(lock.tangled, (path) => !produced.has(path))

const sortedUnique = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  pipe(paths, Array.dedupe, Array.sort(Order.String))

export const recorded = (
  lock: LoomLock,
  produced: ReadonlyArray<string>,
): LoomLock => ({ version: 1, tangled: sortedUnique([...lock.tangled, ...produced]) })

export const pruned = (produced: ReadonlyArray<string>): LoomLock => ({
  version: 1,
  tangled: sortedUnique(produced),
})
