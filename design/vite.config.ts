import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { loomDevtools } from '@athrio/loom-devtools/vite'

export default defineConfig({
  esbuild: { target: 'es2022' },
  plugins: [loomDevtools({ project: 'loom-landing' })],
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: { index: fileURLToPath(new URL('index.html', import.meta.url)) },
    },
  },
})
