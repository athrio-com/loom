const scope = globalThis as { window?: unknown }

if (!('window' in scope)) {
  scope.window = undefined
}
