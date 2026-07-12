import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// Serve the landing design as a plain static page. The Loom Notes overlay is
// added by a raw <script> tag in index.html — the agnostic path, no plugin —
// so this proves the overlay works on any page. Start the notes daemon first
// (`loom start`, default port 5710), then:
//   bunx --bun vite --config design/vite.config.ts --port 5199
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
})
