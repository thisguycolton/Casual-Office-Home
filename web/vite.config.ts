import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  // See the comment in the stub: this Univer package is imported by the Sheets SDK but not published to npm.
  resolve: { alias: { '@univerjs/docs-mention-ui': fileURLToPath(new URL('./src/stubs/univer-docs-mention-ui.ts', import.meta.url)) } },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
  worker: { format: 'es' },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
});
