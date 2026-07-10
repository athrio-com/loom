import { defineConfig } from 'vite'
import { loomAnnotate } from '@athrio/loom-annotate'

// The website is a Foldkit SPA on Effect. Effect ships modern syntax, so target a
// current baseline. The annotation utility runs only in dev; a build carries no
// trace of it. Vite must run under Bun (see the root bunfig.toml) because the
// plugin uses Bun for the filesystem and to transpile its overlay.
export default defineConfig({
  esbuild: { target: 'es2022' },
  build: { target: 'es2022' },
  plugins: [loomAnnotate()],
})
