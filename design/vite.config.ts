import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { loomAnnotate } from '@athrio/loom-annotate'

// Serve the landing design and annotate it. Run under Bun so the plugin's
// Bun runtime is used:
//   bunx --bun vite --config design/vite.config.ts --port 5199
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [loomAnnotate()],
})
