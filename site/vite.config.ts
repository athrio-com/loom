import { defineConfig } from 'vite'
import { loomAnnotate } from '@athrio/loom-annotate'

export default defineConfig({
  esbuild: { target: 'es2022' },
  build: { target: 'es2022' },
  plugins: [loomAnnotate()],
})
