import { defineConfig } from 'vite'
import { foldkit } from '@athrio/foldkit-vite-plugin'

export default defineConfig({
  esbuild: { target: 'es2022' },
  build: { target: 'es2022' },
  plugins: [foldkit({ devToolsMcpPort: 9988 })],
  server: {
    proxy: {
      '/data': 'http://localhost:4321',
    },
  },
})
