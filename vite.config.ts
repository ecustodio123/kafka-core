import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  define: { 'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(/^[a-f0-9]{7,40}$/.test(process.env.CF_PAGES_COMMIT_SHA ?? '') ? process.env.CF_PAGES_COMMIT_SHA : 'unknown') },
  plugins: [react(), tailwindcss()],
})
