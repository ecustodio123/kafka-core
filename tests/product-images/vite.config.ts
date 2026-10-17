import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Never loads .env or connects the harness to a real Supabase project.
export default defineConfig({
  envDir: false,
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('http://127.0.0.1:5197'),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('local-public-test-key'),
  },
  server: { host: '127.0.0.1', port: 5197, strictPort: true },
})
