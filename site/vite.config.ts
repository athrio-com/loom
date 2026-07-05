import { defineConfig } from 'vite'

// The reader is a Foldkit SPA on Effect. Effect ships modern syntax, so target a
// current baseline.
export default defineConfig({
  esbuild: { target: 'es2022' },
  build: { target: 'es2022' },
})
