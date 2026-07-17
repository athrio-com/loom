import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  esbuild: { target: 'es2022' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: {
        todo: fileURLToPath(new URL('index.html', import.meta.url)),
        chat: fileURLToPath(new URL('chat.html', import.meta.url)),
        lab: fileURLToPath(new URL('lab.html', import.meta.url)),
      },
    },
  },
})
