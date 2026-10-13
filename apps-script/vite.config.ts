// Builds the web app for Google Apps Script: the same screens, with the API
// client swapped for google.script.run, all in one file (see build.mjs).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, normalizePath, type Plugin } from 'vite';

// Forward slashes, as Vite names files (on Windows too), so the client swap below matches.
const here = (path: string) => normalizePath(fileURLToPath(new URL(path, import.meta.url)));
const webClient = here('../web/src/api/client.ts');
const appsScriptClient = here('./client/api.ts');
// Line endings as in git (this machine may have checked the file out with CRLF).
const logoSvg = readFileSync(here('../web/public/favicon.svg'), 'utf8').replace(/\r+\n/g, '\n');
const logo = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}`;
function appsScript(): Plugin {
  return {
    name: 'toretto-apps-script',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // However it's imported (./client, ../api/client, ...), by what it resolves to.
      if (!importer || !/(^|\/)client(\.ts)?$/.test(source)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved?.id === webClient ? appsScriptClient : null;
    },
    // The page has no /favicon.svg to point at: embed the logo.
    transform(code, id) {
      if (!id.includes('/web/src/') || !code.includes('"/favicon.svg"')) return null;
      return code.replaceAll('"/favicon.svg"', JSON.stringify(logo));
    },
  };
}

export default defineConfig({
  root: here('./client'),
  base: './',
  plugins: [appsScript(), react(), tailwindcss()],
  resolve: { alias: { '@shared': here('../shared') } },
  build: {
    outDir: here('./.client-build'),
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    modulePreload: false,
    rolldownOptions: { output: { codeSplitting: false } },
    // One big file on purpose: Apps Script serves the page as a single file.
    chunkSizeWarningLimit: 4096,
  },
});
