import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        momWar: 'mom-war.html',
        cops: 'cops.html',
        dashboard: 'dashboard.html',
        studio: 'studio.html',
      },
    },
  },
});
