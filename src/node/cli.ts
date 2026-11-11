#!/usr/bin/env node
/**
 * tripalogue — Phase 0 command-line tools.
 *
 *   tripalogue new <file> --title "Trip name" [--aspect 16:9|9:16|1:1]
 *   tripalogue validate <file>
 *   tripalogue info <file>
 *   tripalogue cache <file> [--cache-dir DIR] [--apply-probes]
 *   tripalogue serve <file> [--port N] [--cache-dir DIR] [--telemetry-dir DIR]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createProject, ProjectFormatError } from '../core/project.js';
import { buildTimeline } from '../core/timeline.js';
import { applyProbes, buildCache, defaultCacheRoot } from './cache.js';
import { serve } from './server.js';
import { openProject, saveProject } from './storage.js';

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const USAGE = `Usage:
  tripalogue new <file> --title "Trip name" [--aspect 16:9|9:16|1:1]
  tripalogue validate <file>
  tripalogue info <file>
  tripalogue cache <file> [--cache-dir DIR] [--apply-probes]
  tripalogue serve <file> [--port N] [--cache-dir DIR] [--telemetry-dir DIR]`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const file = positional[0] && path.resolve(positional[0]);
  if (!cmd || cmd === 'help' || flags.help || !file) {
    console.log(USAGE);
    return cmd && cmd !== 'help' && !flags.help ? 1 : 0;
  }
  try {
    switch (cmd) {
      case 'new': {
        try {
          await fs.access(file);
          console.error(`${file} already exists`);
          return 1;
        } catch { /* good */ }
        const p = createProject({ title: String(flags.title ?? path.basename(file).replace(/\..*$/, '')), aspect: (flags.aspect as '16:9') ?? '16:9' });
        await saveProject(file, p);
        console.log(`Created ${file}`);
        return 0;
      }
      case 'validate': {
        const r = await openProject(file);
        for (const w of r.warnings) console.log(`warning ${w.path}: ${w.message}`);
        if (r.migratedFrom !== undefined) console.log(`note: migrated from schema v${r.migratedFrom}; save to upgrade the file`);
        if (r.recovery) console.log(`note: an unsaved autosave from ${r.recovery.savedAt.toISOString()} is available`);
        console.log(`OK: ${file}`);
        return 0;
      }
      case 'info': {
        const { project: p } = await openProject(file);
        const tl = buildTimeline(p);
        console.log(`${p.title} (${p.output.width}x${p.output.height} @ ${p.output.fps} fps)`);
        console.log(`${p.chapters.length} chapters, ${p.media.length} media items, ${tl.segments.length} segments, runtime ${fmt(tl.duration)}`);
        for (const c of tl.chapters) {
          const n = tl.segments.filter((s) => s.chapterId === c.chapterId && s.kind !== 'title').length;
          console.log(`  ${String(c.index + 1).padStart(2)}. ${c.title.padEnd(32)} ${fmt(c.start)} – ${fmt(c.end)}  ${n} items`);
        }
        const unassigned = p.media.filter((m) => m.chapterId === null).length;
        if (unassigned) console.log(`  Unassigned: ${unassigned} items (not played)`);
        for (const s of tl.skipped) console.log(`  skipped ${s.itemId}: ${s.reason}`);
        return 0;
      }
      case 'cache': {
        const r = await openProject(file);
        const root = typeof flags['cache-dir'] === 'string' ? path.resolve(flags['cache-dir']) : defaultCacheRoot();
        console.log(`Cache: ${root}`);
        const t0 = Date.now();
        const { manifest } = await buildCache(file, r.project, { root, log: (m) => console.log(m) });
        const errors = Object.values(manifest.entries).filter((e) => e.error);
        console.log(`Built ${Object.keys(manifest.entries).length} entries in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${errors.length} error(s)`);
        if (flags['apply-probes']) {
          const next = applyProbes(r.project, manifest);
          if (next !== r.project) {
            await saveProject(file, next);
            console.log('Wrote probed sizes and durations into the project');
          }
        }
        return errors.length ? 2 : 0;
      }
      case 'serve': {
        const root = typeof flags['cache-dir'] === 'string' ? path.resolve(flags['cache-dir']) : defaultCacheRoot();
        const s = await serve({
          projectFile: file,
          port: flags.port ? Number(flags.port) : 5173,
          cacheRoot: root,
          telemetryDir: typeof flags['telemetry-dir'] === 'string' ? path.resolve(flags['telemetry-dir']) : undefined,
          log: (m) => console.error(m),
        });
        console.log(`Player: ${s.url}  (Ctrl+C to stop)`);
        await new Promise(() => {});
        return 0;
      }
      default:
        console.error(`Unknown command "${cmd}"\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    if (e instanceof ProjectFormatError) console.error(e.message);
    else console.error(`Error: ${(e as Error).message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) main().then((code) => process.exit(code));
