import type { HydrationStrategy } from 'foldkit/runtime'
import { adopt } from './adopt'
import { replayPreHydrationInput } from './prehydration'
import { snapshotServerNodes, warnOnHydrationRebuild } from './conformance'

export type SsrHydrationOptions = Readonly<{ warnOnRebuild?: boolean }>

export const ssrHydration = (options: SsrHydrationOptions = {}): HydrationStrategy => {
  const warnOnRebuild = options.warnOnRebuild ?? false
  // The two callbacks below share this one snapshot: mountSource captures the
  // server nodes as it adopts, afterFirstPatch checks which the merge replaced.
  let snapshot: ReadonlyArray<Element> = []

  return {
    mountSource: (container) => {
      if (warnOnRebuild) {
        snapshot = snapshotServerNodes(container)
      }
      return adopt(container.firstElementChild!)
    },
    afterFirstPatch: (container) => {
      replayPreHydrationInput()
      if (warnOnRebuild) {
        warnOnHydrationRebuild(snapshot, container)
      }
    },
  }
}
