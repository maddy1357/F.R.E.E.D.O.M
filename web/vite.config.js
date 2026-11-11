import { defineConfig } from 'vite';

// Relative base so the build works at https://<user>.github.io/<repo>/ and from any folder.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2022' },
});
