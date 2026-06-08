import * as serverProtocol from '@volar/language-server/protocol'
import { activateAutoInsertion, createLabsInfo } from '@volar/vscode'
import * as path from 'node:path'
import * as vscode from 'vscode'
import {
  type BaseLanguageClient,
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node'

let client: BaseLanguageClient

export async function activate(context: vscode.ExtensionContext) {
  const serverModule = vscode.Uri.joinPath(
    context.extensionUri,
    'dist',
    'server.js',
  )
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule.fsPath,
      transport: TransportKind.ipc,
      options: { execArgv: [] as string[] },
    },
    debug: {
      module: serverModule.fsPath,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  }

  // The server type-checks the synthesised frame, so it needs a TypeScript
  // `lib/`. Rather than bundle one, point it at the TypeScript VS Code already
  // ships (`loadTsdkByPath` on the server loads `typescript.js` and resolves the
  // `lib.*.d.ts` from this directory).
  const tsdk = path.join(
    vscode.env.appRoot,
    'extensions',
    'node_modules',
    'typescript',
    'lib',
  )

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'loom' }],
    initializationOptions: { typescript: { tsdk } },
  }

  client = new LanguageClient(
    'loom-language-server',
    'Loom Language Server',
    serverOptions,
    clientOptions,
  )
  await client.start()

  activateAutoInsertion('loom', client)

  const labsInfo = createLabsInfo(serverProtocol)
  labsInfo.addLanguageClient(client)
  return labsInfo.extensionExports
}

export function deactivate(): Thenable<any> | undefined {
  return client?.stop()
}
