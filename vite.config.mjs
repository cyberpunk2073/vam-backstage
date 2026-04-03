// Shim for shadcn CLI detection. The actual build config is in electron.vite.config.mjs.
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src/renderer/src')
    }
  },
  plugins: [react(), tailwindcss()]
})
