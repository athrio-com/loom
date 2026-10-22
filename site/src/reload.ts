import { Effect, Option, Stream } from 'effect'

const reloads = (address: string): Stream.Stream<Event> =>
  Stream.fromEventListener(new EventSource(address), 'reload')

const reloadOn = (address: string): Effect.Effect<void> =>
  Stream.runForEach(reloads(address), () => Effect.sync(() => window.location.reload()))

Option.match(Option.fromNullishOr(import.meta.env.VITE_RELOAD_URL), {
  onNone: () => undefined,
  onSome: (address) => void Effect.runFork(reloadOn(address)),
})
