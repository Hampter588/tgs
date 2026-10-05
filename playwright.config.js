import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', workers: 1, use: { baseURL: 'http://127.0.0.1:5174' }, webServer: [
  { command: 'node server/tests/runtime.mjs', url: 'http://127.0.0.1:3002/api/health', reuseExistingServer: false },
  { command: 'npm run dev -- --port 5174 --strictPort', url: 'http://127.0.0.1:5174', reuseExistingServer: false, env: { TGS_BACKEND_URL: 'http://127.0.0.1:3002', VITE_API_URL: '' } }
] });
