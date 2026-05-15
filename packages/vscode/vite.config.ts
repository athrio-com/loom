import { defineConfig } from "vite"
import { builtinModules, createRequire } from "node:module"
import { resolve } from "node:path"

const require = createRequire(import.meta.url)
const pkg = require("./package.json") as { dependencies?: Record<string, string> }
const runtimeDeps = Object.keys(pkg.dependencies ?? {})

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

const isExternal = (id: string): boolean => {
  if (id === "vscode") return true
  if (nodeBuiltins.includes(id) || id.startsWith("node:")) return true
  return runtimeDeps.some((d) => id === d || id.startsWith(`${d}/`))
}

export default defineConfig({
  resolve: {
    conditions: ["node"],
    mainFields: ["main", "module"],
  },
  build: {
    target: "node26",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(__dirname, "src/vscode-extension.ts"),
      formats: ["cjs"],
      fileName: () => "vscode-extension.js",
    },
    rollupOptions: {
      external: isExternal,
    },
  },
})
