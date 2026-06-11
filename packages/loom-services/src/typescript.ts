import { create } from 'volar-service-typescript'
import { Effect } from 'effect'
import { defineLoomService } from './LoomService'

export const typescript = defineLoomService({
  id: 'typescript',
  displayName: 'TypeScript',
  plugins: (context) => Effect.succeed(create(context.typescript)),
})
