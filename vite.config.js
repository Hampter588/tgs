import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], base: './', server: { proxy: { '/api': process.env.TGS_BACKEND_URL || 'http://127.0.0.1:3001' } } });
