// Bundles the server (and CLI scripts) into dist/server with esbuild.
import { cp, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist/server', { recursive: true, force: true });
await build({
  entryPoints: {
    index: 'server/src/index.ts',
    worker: 'server/src/worker-main.ts',
    migrate: 'server/scripts/migrate.ts',
    seed: 'server/scripts/seed.ts',
    'create-admin': 'server/scripts/create-admin.ts',
  },
  outdir: 'dist/server',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  alias: { '@shared': './shared' },
  sourcemap: true,
  logLevel: 'info',
});
await cp('server/migrations', 'dist/server/migrations', { recursive: true });
