// Build: compile core, server and CLI with tsc; bundle the web client with esbuild.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
rmSync(path.join(root, 'dist'), { recursive: true, force: true });

const tsc = require.resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], { stdio: 'inherit' });
chmodSync(path.join(root, 'dist/node/cli.js'), 0o755);

const esbuild = await import('esbuild');
mkdirSync(path.join(root, 'dist/web'), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/web/main.ts')],
  outfile: path.join(root, 'dist/web/app.js'),
  bundle: true,
  format: 'iife',
  target: ['chrome110', 'firefox115', 'safari16'],
  sourcemap: true,
  minify: false,
  logLevel: 'warning',
});
// The export page: drawn in a headless browser by the render worker, with the player's drawing code.
await esbuild.build({
  entryPoints: [path.join(root, 'src/web/render-page.ts')],
  outfile: path.join(root, 'dist/web/render.js'),
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  sourcemap: true,
  logLevel: 'warning',
});
// Its frame sender, which converts and uploads frames while the page draws the next.
await esbuild.build({
  entryPoints: [path.join(root, 'src/web/render-worker.ts')],
  outfile: path.join(root, 'dist/web/render-worker.js'),
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  sourcemap: true,
  logLevel: 'warning',
});
for (const f of ['index.html', 'app.css', 'guide-contributors.html', 'render.html']) copyFileSync(path.join(root, 'src/web', f), path.join(root, 'dist/web', f));
console.log('Built dist/node, dist/server and dist/web');
