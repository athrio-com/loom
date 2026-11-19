import { Match, Option } from 'effect'

export interface StorageStub {
  readonly url: string
  readonly locationOf: (name: string) => string
  readonly write: (name: string, text: string) => void
  readonly stop: () => void
}

const workspacePath = '/workspace'

const answerTo = Match.fn(
  (
    _within: {
      readonly workspaceJson: () => unknown
      readonly texts: ReadonlyMap<string, string>
    },
    asked: { readonly authorised: boolean; readonly name: string },
  ) => asked,
).pipe(
  Match.withReturnType<Response>(),
  Match.when({ authorised: false }, () => new Response('unauthorised', { status: 401 })),
  Match.when({ name: '' }, (_asked, { workspaceJson }) => Response.json(workspaceJson())),
  Match.orElse(({ name }, { texts }) =>
    Option.match(Option.fromNullishOr(texts.get(name)), {
      onNone: () => new Response('no such loom', { status: 404 }),
      onSome: (text) => new Response(text),
    }),
  ),
)

export const storageStub = (
  key: string,
  looms: ReadonlyArray<readonly [string, string]>,
): StorageStub => {
  const texts = new Map(looms)
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => answer(request) })
  const url = `http://127.0.0.1:${server.port}${workspacePath}`
  const locationOf = (name: string): string => `${url}/${name}`
  const workspaceJson = () => ({
    contract: 1,
    manifest: { primary: 'typescript' },
    looms: Object.fromEntries([...texts].map(([name, text]) => [locationOf(name), text])),
  })
  const answer = (request: Request): Response =>
    answerTo({ workspaceJson, texts }, {
      authorised: request.headers.get('authorization') === `Bearer ${key}`,
      name: new URL(request.url).pathname.slice(workspacePath.length + 1),
    })
  return {
    url,
    locationOf,
    write: (name, text) => void texts.set(name, text),
    stop: () => void server.stop(true),
  }
}
