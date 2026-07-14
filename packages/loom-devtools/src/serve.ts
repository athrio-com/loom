import { Effect, Layer } from 'effect'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { notesServer, devtoolsLogger } from './api'

const port = Number(process.env.PORT ?? 5710)

BunRuntime.runMain(
  Layer.launch(notesServer(port)).pipe(
    Effect.provide(devtoolsLogger),
    Effect.provide(BunServices.layer),
  ),
)
