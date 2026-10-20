import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  esbuild: { target: 'es2022' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: { index: fileURLToPath(new URL('index.html', import.meta.url)) },
      watch: { buildDelay: 300 },
    },
  },
})
