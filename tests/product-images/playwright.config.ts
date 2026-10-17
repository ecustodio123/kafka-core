import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const chrome = process.env.PRODUCT_IMAGES_BROWSER ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:5197', headless: true,
    launchOptions: existsSync(chrome) ? { executablePath: chrome } : {} },
  webServer: {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    command: 'node node_modules/vite/bin/vite.js --config tests/product-images/vite.config.ts',
    url: 'http://127.0.0.1:5197/tests/product-images/browser.html', reuseExistingServer: false,
  },
})
