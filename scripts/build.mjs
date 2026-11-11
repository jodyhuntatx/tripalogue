// Build: compile core + node tools with tsc, bundle the player with esbuild.
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
mkdirSync(path.join(root, 'dist/player'), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/player/main.ts')],
  outfile: path.join(root, 'dist/player/player.js'),
  bundle: true,
  format: 'iife',
  target: ['chrome110', 'firefox115', 'safari16'],
  sourcemap: true,
  minify: false,
  logLevel: 'warning',
});
copyFileSync(path.join(root, 'src/player/index.html'), path.join(root, 'dist/player/index.html'));
console.log('Built dist/node and dist/player');
