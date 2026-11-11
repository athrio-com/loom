import * as serverProtocol from '@volar/language-server/protocol'
import { activateAutoInsertion, createLabsInfo } from '@volar/vscode'
import * as path from 'node:path'
import * as vscode from 'vscode'
import {
  type BaseLanguageClient,
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  type StaticFeature,
  TransportKind,
  type WorkspaceEdit,
} from 'vscode-languageclient/node'

let client: BaseLanguageClient

type MoveTarget = { readonly title: string; readonly edit: WorkspaceEdit }

const pickTarget = async (targets: ReadonlyArray<MoveTarget>): Promise<void> => {
  const picked = await vscode.window.showQuickPick(
    targets.map((target) => ({ label: target.title, target })),
    { placeHolder: 'Move the concept up to' },
  )
  if (picked !== undefined) {
    await vscode.workspace.applyEdit(
      await client.protocol2CodeConverter.asWorkspaceEdit(picked.target.edit),
    )
  }
}

const announcePicker: StaticFeature = {
  fillClientCapabilities: (capabilities) => {
    capabilities.experimental = {
      ...(capabilities.experimental as object | undefined),
      commands: { commands: ['loom.moveConcept'] },
    }
  },
  initialize: () => undefined,
  getState: () => ({ kind: 'static' }),
  clear: () => undefined,
}

export async function activate(context: vscode.ExtensionContext) {
  const serverModule = vscode.Uri.joinPath(context.extensionUri, 'dist', 'server.js')
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

  const tsdk = path.join(vscode.env.appRoot, 'extensions', 'node_modules', 'typescript', 'lib')

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
  client.registerFeature(announcePicker)
  context.subscriptions.push(vscode.commands.registerCommand('loom.moveConcept', pickTarget))
  await client.start()

  activateAutoInsertion('loom', client)

  const labsInfo = createLabsInfo(serverProtocol)
  labsInfo.addLanguageClient(client)
  return labsInfo.extensionExports
}

export function deactivate(): Thenable<any> | undefined {
  return client?.stop()
}
