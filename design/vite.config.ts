import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// The Loom design catalog — a small multi-page web app.
//   bun run dev     serve the catalog (http://localhost:5199)
//   bun run build   bundle every page to dist/
// Every page carries the Loom Notes overlay through a raw <script> tag (the
// agnostic path); run `loom start` to have the daemon behind it.
const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        docs: resolve(root, 'docs.html'),
        annotations: resolve(root, 'annotations.html'),
        devtools: resolve(root, 'devtools.html'),
      },
    },
  },
})
