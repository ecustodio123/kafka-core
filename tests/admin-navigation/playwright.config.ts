import { defineConfig } from '@playwright/test'
import config from '../product-images/playwright.config'
const server = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer!
export default defineConfig({ ...config, testDir: '.', testMatch: '*.spec.ts',
  webServer: { ...server, url: 'http://127.0.0.1:5197/tests/admin-navigation/browser.html' },
})
