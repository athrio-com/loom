import {
  Array,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  pipe,
  Ref,
  Result as Result_,
  Schedule,
  Schema as S,
} from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { BunServices } from '@effect/platform-bun'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Entry, Result } from './search'

const Vectors = S.Array(S.Array(S.Number))

const Info = S.Struct({ model_sha: S.String })

export type Vector = ReadonlyArray<number>

export class Embeddings extends Context.Service<Embeddings>()('Embeddings', {
  make: Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const service = yield* Config.String('LOOM_EMBEDDINGS').pipe(Config.withDefault('http://localhost:8090'))
    return {
      embed: (inputs: ReadonlyArray<string>, prompt: Option.Option<string>) =>
        client
          .execute(
            HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(`${service}/embed`), {
              inputs,
              normalize: true,
              truncate: true,
              ...Option.match(prompt, { onNone: () => ({}), onSome: (name) => ({ prompt_name: name }) }),
            }),
          )
          .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Vectors))),
      revision: client
        .execute(HttpClientRequest.get(`${service}/info`))
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Info)),
          Effect.map((info) => info.model_sha),
        ),
    } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}

const nearness = (one: Vector, other: Vector): number =>
  Array.reduce(one, 0, (sum, value, at) => sum + value * (other[at] ?? 0))

export const passageOf = (entry: Entry): string => `${entry.place} — ${entry.heading}\n${entry.text}`

export const keyOf = (entry: Entry): string => createHash('sha256').update(passageOf(entry)).digest('hex')

export const Store = S.Struct({ revision: S.String, vectors: S.Record(S.String, S.String) })

export type Store = typeof Store.Type

export const storePath = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'meaning.json')

export const encodeVector = (vector: Vector): string =>
  Buffer.from(new Float32Array(vector).buffer).toString('base64')

const decodeVector = (text: string): Vector =>
  Array.fromIterable(new Float32Array(new Uint8Array(Buffer.from(text, 'base64')).buffer))

const decodeStore = S.decodeUnknownOption(Store)

export const readStore = (fs: FileSystem.FileSystem): Effect.Effect<Option.Option<Store>> =>
  fs.readFileString(storePath).pipe(
    Effect.map((text) =>
      Option.flatMap(Option.liftThrowable((json: string): unknown => JSON.parse(json))(text), decodeStore),
    ),
    Effect.catchCause(() => Effect.succeed(Option.none())),
  )

const BATCH = 32

export const embedAll = (embeddings: Embeddings['Service'], passages: ReadonlyArray<string>) =>
  Effect.map(
    Effect.forEach(Array.chunksOf(passages, BATCH), (batch) => embeddings.embed(batch, Option.none())),
    Array.flatten,
  )

const RETRY = Schedule.spaced('1 minute')

const THRESHOLD = 0.29

const wordsIn = (entry: Entry, query: string): string =>
  pipe(
    query.toLowerCase().split(/[^\p{L}\p{N}-]+/u),
    Array.filter((word) => word.length >= 3 && entry.text.toLowerCase().includes(word)),
    Array.sort(Order.mapInput(Order.flip(Order.Number), (word: string) => word.length)),
    Array.head,
    Option.getOrElse(() => ''),
  )

type Keyed = { readonly entry: Entry; readonly key: string }

type Ready = Keyed & { readonly vector: Vector }

export class Meaning extends Context.Service<Meaning>()('Meaning', {
  make: Effect.gen(function* () {
    const embeddings = yield* Embeddings
    const kept = yield* readStore(yield* FileSystem.FileSystem)
    const known = yield* Ref.make<ReadonlyMap<string, Vector>>(new Map())
    const checked = yield* Ref.make(false)
    const filling = yield* Ref.make(false)

    const adopt = (revision: string): ReadonlyMap<string, Vector> =>
      Option.match(
        Option.filter(kept, (store) => store.revision === revision),
        {
          onNone: () => new Map(),
          onSome: (store) =>
            new Map(Array.map(Object.entries(store.vectors), ([key, text]) => [key, decodeVector(text)] as const)),
        },
      )

    const check = Effect.flatMap(Ref.getAndSet(checked, true), (done) =>
      done
        ? Effect.void
        : embeddings.revision.pipe(
            Effect.flatMap((revision) => Ref.set(known, adopt(revision))),
            Effect.catchCause(() => Ref.set(checked, false)),
          ),
    )

    const fill = (missing: ReadonlyArray<Keyed>) =>
      Effect.flatMap(embedAll(embeddings, Array.map(missing, ({ entry }) => passageOf(entry))), (vectors) =>
        Ref.update(
          known,
          (have) => new Map([...have, ...Array.zip(Array.map(missing, ({ key }) => key), vectors)]),
        ),
      ).pipe(Effect.retry(RETRY), Effect.ensuring(Ref.set(filling, false)))

    const startFilling = (missing: ReadonlyArray<Keyed>) =>
      missing.length === 0
        ? Effect.void
        : Effect.flatMap(Ref.getAndSet(filling, true), (under) =>
            under ? Effect.void : Effect.asVoid(Effect.forkDetach(fill(missing))),
          )

    const ranked = (ready: ReadonlyArray<Ready>, query: string) =>
      Effect.map(embeddings.embed([query], Option.some('query')), (answer) =>
        pipe(
          Option.fromNullishOr(answer[0]),
          Option.map((asked) =>
            pipe(
              Array.map(ready, ({ entry, vector }) => ({ entry, near: nearness(asked, vector) })),
              Array.filter((each) => each.near >= THRESHOLD),
              Array.sort(Order.mapInput(Order.flip(Order.Number), (each: { near: number }) => each.near)),
              Array.map((each): Result => ({ entry: each.entry, words: wordsIn(each.entry, query), meaning: true })),
            ),
          ),
          Option.filter((results) => results.length > 0),
        ),
      )

    return {
      rank: (index: ReadonlyArray<Entry>, query: string): Effect.Effect<Option.Option<ReadonlyArray<Result>>> =>
        Effect.gen(function* () {
          yield* check
          const have = yield* Ref.get(known)
          const [ready, missing] = Array.partition(
            Array.map(index, (entry): Keyed => ({ entry, key: keyOf(entry) })),
            (each): Result_.Result<Ready, Keyed> =>
              Option.match(Option.fromNullishOr(have.get(each.key)), {
                onNone: () => Result_.fail(each),
                onSome: (vector) => Result_.succeed({ ...each, vector }),
              }),
          )
          yield* startFilling(missing)
          return ready.length === 0 ? Option.none() : yield* ranked(ready, query)
        }).pipe(Effect.catchCause(() => Effect.succeed(Option.none()))),
    } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Embeddings.layer),
    Layer.provide(BunServices.layer),
  )
}
