import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(here, 'src/TypescriptService.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: (id) => !id.startsWith('.') && !id.startsWith('/'),
    },
  },
})
