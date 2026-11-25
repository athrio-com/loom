import { Match, Option } from 'effect'

export interface StubWorkspace {
  readonly name: string
  readonly manifest: object
  readonly looms: ReadonlyArray<readonly [string, string]>
}

export interface StorageStub {
  readonly storage: string
  readonly addressOf: (workspace: string) => string
  readonly locationOf: (workspace: string, name: string) => string
  readonly openings: (workspace: string) => number
  readonly write: (workspace: string, name: string, text: string) => void
  readonly remove: (workspace: string, name: string) => void
  readonly configure: (workspace: string, manifest: object) => void
  readonly stop: () => void
}

interface Asked {
  readonly authorised: boolean
  readonly workspace: string
  readonly name: string
}

interface Kept {
  readonly workspaceJson: (workspace: string) => Option.Option<unknown>
  readonly textOf: (workspace: string, name: string) => Option.Option<string>
}

const askedOf = (key: string, request: Request): Asked => {
  const [workspace = '', ...path] = new URL(request.url).pathname.slice(1).split('/')
  return {
    authorised: request.headers.get('authorization') === `Bearer ${key}`,
    workspace,
    name: path.join('/'),
  }
}

const notHere = (): Response => new Response('not here', { status: 404 })

const answerTo = Match.fn((_kept: Kept, asked: Asked) => asked).pipe(
  Match.withReturnType<Response>(),
  Match.when({ authorised: false }, () => new Response('unauthorised', { status: 401 })),
  Match.when({ name: '' }, ({ workspace }, { workspaceJson }) =>
    Option.match(workspaceJson(workspace), {
      onNone: notHere,
      onSome: (json) => Response.json(json),
    }),
  ),
  Match.orElse(({ workspace, name }, { textOf }) =>
    Option.match(textOf(workspace, name), {
      onNone: notHere,
      onSome: (text) => new Response(text),
    }),
  ),
)

export const storageStub = (key: string, workspaces: ReadonlyArray<StubWorkspace>): StorageStub => {
  const texts = new Map(
    workspaces.map((workspace) => [workspace.name, new Map(workspace.looms)] as const),
  )
  const manifests = new Map(workspaces.map((workspace) => [workspace.name, workspace.manifest]))
  const opened = new Map<string, number>()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => answer(request) })
  const storage = `http://127.0.0.1:${server.port}`
  const addressOf = (workspace: string): string => `${storage}/${workspace}`
  const locationOf = (workspace: string, name: string): string => `${addressOf(workspace)}/${name}`
  const loomsOf = (workspace: string): ReadonlyMap<string, string> =>
    Option.getOrElse(Option.fromNullishOr(texts.get(workspace)), () => new Map<string, string>())
  const openings = (workspace: string): number =>
    Option.getOrElse(Option.fromNullishOr(opened.get(workspace)), () => 0)
  const workspaceJson = (workspace: string): Option.Option<unknown> =>
    Option.map(Option.fromNullishOr(texts.get(workspace)), (looms) => {
      opened.set(workspace, openings(workspace) + 1)
      return {
        contract: 1,
        manifest: manifests.get(workspace),
        looms: Object.fromEntries(
          [...looms].map(([name, text]) => [locationOf(workspace, name), text]),
        ),
      }
    })
  const textOf = (workspace: string, name: string): Option.Option<string> =>
    Option.fromNullishOr(loomsOf(workspace).get(name))
  const answer = (request: Request): Response =>
    answerTo({ workspaceJson, textOf }, askedOf(key, request))
  return {
    storage,
    addressOf,
    locationOf,
    openings,
    write: (workspace, name, text) =>
      void texts.set(workspace, new Map(loomsOf(workspace)).set(name, text)),
    remove: (workspace, name) =>
      void texts.set(workspace, new Map([...loomsOf(workspace)].filter(([kept]) => kept !== name))),
    configure: (workspace, manifest) => void manifests.set(workspace, manifest),
    stop: () => void server.stop(true),
  }
}
