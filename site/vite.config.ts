import { defineConfig } from 'vite'
import { foldkit } from '@foldkit/vite-plugin'
import { loomDevtools } from '@athrio/loom-devtools/vite'

export default defineConfig({
  esbuild: { target: 'es2022' },
  build: { target: 'es2022' },
  plugins: [foldkit({ devToolsMcpPort: 9988 }), loomDevtools({ project: 'loom-website' })],
  server: {
    proxy: {
      '/data': 'http://localhost:4321',
    },
  },
})
