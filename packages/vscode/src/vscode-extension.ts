import * as serverProtocol from "@volar/language-server/protocol";
import { activateAutoInsertion, createLabsInfo } from "@volar/vscode";
import * as vscode from "vscode";
import {
  type BaseLanguageClient,
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: BaseLanguageClient;

export async function activate(context: vscode.ExtensionContext) {
  // Diagnostic: confirm the named imports actually arrived at runtime.
  // Remove once activation is working.
  console.log("[Loom activate] TransportKind:", TransportKind);
  console.log("[Loom activate] LanguageClient:", typeof LanguageClient);

  const serverModule = vscode.Uri.joinPath(
    context.extensionUri,
    "node_modules",
    "@loom/language-server",
    "dist",
    "loom-server.js",
  );
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule.fsPath,
      transport: TransportKind.ipc,
      options: { execArgv: [] as string[] },
    },
    debug: {
      module: serverModule.fsPath,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6009"] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: "loom" }],
    initializationOptions: {},
  };

  client = new LanguageClient(
    "loom-language-server",
    "Loom Language Server",
    serverOptions,
    clientOptions,
  );
  await client.start();

  activateAutoInsertion("loom", client);

  const labsInfo = createLabsInfo(serverProtocol);
  labsInfo.addLanguageClient(client);
  return labsInfo.extensionExports;
}

export function deactivate(): Thenable<any> | undefined {
  return client?.stop();
}