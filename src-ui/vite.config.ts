import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Tauri dev server
  server: {
    port: 5173,
    strictPort: true,
  },
  // Allow Tauri IPC
  envPrefix: ['VITE_', 'TAURI_'],
  // Build-time platform constant. Each platform's installer is built on its
  // own CI runner (release.yml: ubuntu-22.04 / windows-latest / macos-13),
  // so process.platform here = the target platform of the binary being
  // produced. Far more reliable than navigator.userAgent — WebKit2GTK's UA
  // string is configurable and has been observed to omit "Linux" on some
  // distro/Tauri-version combos, defeating the runtime gate.
  define: {
    __IS_LINUX__: JSON.stringify(process.platform === 'linux'),
  },
  build: {
    // Tauri supports es2021
    target: ['es2021', 'chrome105', 'safari15'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
});
