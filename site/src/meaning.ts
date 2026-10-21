import { Array, Config, Context, Effect, Layer, Option, Order, pipe, Ref, Schedule, Schema as S } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import type { Entry, Result } from './search'

const Vectors = S.Array(S.Array(S.Number))

type Vector = ReadonlyArray<number>

const nearness = (one: Vector, other: Vector): number =>
  Array.reduce(one, 0, (sum, value, at) => sum + value * (other[at] ?? 0))

const passageOf = (entry: Entry): string => `${entry.place} — ${entry.heading}\n${entry.text}`

const BATCH = 32

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

export class Meaning extends Context.Service<Meaning>()('Meaning', {
  make: Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const service = yield* Config.String('LOOM_EMBEDDINGS').pipe(Config.withDefault('http://localhost:8090'))
    const vectors = yield* Ref.make<Option.Option<ReadonlyArray<Vector>>>(Option.none())
    const embedding = yield* Ref.make(false)

    const embed = (inputs: ReadonlyArray<string>, prompt: Option.Option<string>) =>
      client
        .execute(
          HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(`${service}/embed`), {
            inputs,
            normalize: true,
            truncate: true,
            ...Option.match(prompt, { onNone: () => ({}), onSome: (name) => ({ prompt_name: name }) }),
          }),
        )
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Vectors)))

    const embedIndex = (index: ReadonlyArray<Entry>) =>
      Effect.forEach(Array.chunksOf(Array.map(index, passageOf), BATCH), (batch) => embed(batch, Option.none())).pipe(
        Effect.map(Array.flatten),
        Effect.flatMap((all) => Ref.set(vectors, Option.some(all))),
        Effect.retry(RETRY),
      )

    const startEmbedding = (index: ReadonlyArray<Entry>) =>
      Effect.flatMap(Ref.getAndSet(embedding, true), (under) =>
        under ? Effect.void : Effect.asVoid(Effect.forkDetach(embedIndex(index))),
      )

    const ranked = (index: ReadonlyArray<Entry>, all: ReadonlyArray<Vector>, query: string) =>
      Effect.map(embed([query], Option.some('query')), (answer) =>
        pipe(
          Option.fromNullishOr(answer[0]),
          Option.map((asked) =>
            pipe(
              Array.zipWith(index, all, (entry, vector) => ({ entry, near: nearness(asked, vector) })),
              Array.filter((each) => each.near >= THRESHOLD),
              Array.sort(Order.mapInput(Order.flip(Order.Number), (each: { near: number }) => each.near)),
              Array.map((each): Result => ({ entry: each.entry, words: wordsIn(each.entry, query) })),
            ),
          ),
          Option.filter((results) => results.length > 0),
        ),
      )

    return {
      rank: (index: ReadonlyArray<Entry>, query: string): Effect.Effect<Option.Option<ReadonlyArray<Result>>> =>
        Effect.flatMap(Ref.get(vectors), (ready) =>
          Option.match(ready, {
            onNone: () => Effect.as(startEmbedding(index), Option.none()),
            onSome: (all) => ranked(index, all, query),
          }),
        ).pipe(Effect.catchCause(() => Effect.succeed(Option.none()))),
    } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
