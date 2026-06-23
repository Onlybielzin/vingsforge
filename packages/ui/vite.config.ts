import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Linux-first Tauri renderer. Fixed port so the Tauri dev shell can attach.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
