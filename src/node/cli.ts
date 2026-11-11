#!/usr/bin/env node
/**
 * tripalogue — command-line tools.
 *
 *   tripalogue serve   [--port N] [--data DIR] [--base-url URL] [--no-worker]   run the web app
 *   tripalogue worker  [--data DIR]                                            run media jobs only
 *   tripalogue import  <file> --email you@example.com [--data DIR]             import a project file and its media into an account
 *   tripalogue new     <file> --title "Trip name" [--aspect 16:9|9:16|1:1]     write a new, empty project file
 *   tripalogue validate <file>
 *   tripalogue info    <file>
 */
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createProject, ProjectFormatError } from '../core/project.js';
import { buildTimeline } from '../core/timeline.js';
import { startApp } from '../server/app.js';
import type { Req } from '../server/http.js';
import { openProject, resolveMediaPath, saveProject } from './storage.js';

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
  tripalogue serve   [--port N] [--data DIR] [--base-url URL] [--no-worker]
  tripalogue worker  [--data DIR]
  tripalogue import  <file> --email you@example.com [--data DIR]
  tripalogue new     <file> --title "Trip name" [--aspect 16:9|9:16|1:1]
  tripalogue validate <file>
  tripalogue info    <file>`;

const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const file = positional[0] && path.resolve(positional[0]);
  const dataDir = str(flags.data);
  try {
    switch (cmd) {
      case 'serve': {
        const app = await startApp({ port: flags.port ? Number(flags.port) : undefined, dataDir, baseUrl: str(flags['base-url']), runWorker: !flags['no-worker'], log: (m) => console.error(m) });
        console.log(`TripAlogue is running at ${app.url}  (data: ${app.cfg.dataDir}; Ctrl+C to stop)`);
        console.log('Sign-in links are written to the console and to <data>/outbox until an email provider is configured.');
        await new Promise(() => {});
        return 0;
      }
      case 'worker': {
        const app = await startApp({ port: 0, dataDir, runWorker: true });
        app.server.close();
        console.log(`Media worker running (data: ${app.cfg.dataDir}; Ctrl+C to stop)`);
        await new Promise(() => {});
        return 0;
      }
      case 'import': {
        if (!file || typeof flags.email !== 'string') break;
        const app = await startApp({ port: 0, dataDir, runWorker: true, log: () => {} });
        try {
          const user = app.auth.upsertUser(app.auth.normalizeEmail(flags.email));
          const original = await openProject(file);
          const { project, pending } = app.projects.import(user, await fs.readFile(file, 'utf8'));
          console.log(`Imported "${project.title}" as ${project.id}; uploading ${pending.length} originals…`);
          const roots = new Map(original.project.sources.map((s) => [s.id, s.rootPath]));
          const srcOf = new Map(original.project.media.map((m) => [m.id, m.sourceId]));
          for (const p of pending) {
            const local = resolveMediaPath(file, roots.get(srcOf.get(p.mediaId) ?? ''), p.uri);
            const st = await fs.stat(local);
            const up = await app.uploads.create(project.id, user, { fileName: path.basename(p.uri), size: st.size, mediaId: p.mediaId });
            // Same chunked, offset-checked path the browser uses.
            for (let offset = up.offset; offset < st.size; offset += up.chunkBytes) {
              const end = Math.min(st.size, offset + up.chunkBytes) - 1;
              await app.uploads.putChunk(up.uploadId, user, offset, createReadStream(local, { start: offset, end }) as unknown as Req);
            }
            process.stdout.write('.');
          }
          await app.jobs.idle();
          const { doc } = app.projects.load(project.id);
          const failed = doc.media.filter((m) => m.status === 'failed');
          console.log(`\n${doc.media.length - failed.length} of ${doc.media.length} ready${failed.length ? `; failed: ${failed.map((m) => m.uri).join(', ')}` : ''}`);
          console.log(`Run \`tripalogue serve${dataDir ? ` --data ${dataDir}` : ''}\`, sign in as ${user.email}, and open /#/p/${project.id}`);
          return failed.length ? 2 : 0;
        } finally {
          await app.close();
        }
      }
      case 'new': {
        if (!file) break;
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
        if (!file) break;
        const r = await openProject(file);
        for (const w of r.warnings) console.log(`warning ${w.path}: ${w.message}`);
        if (r.migratedFrom !== undefined) console.log(`note: file is schema v${r.migratedFrom}; it is upgraded on import or save`);
        console.log(`OK: ${file}`);
        return 0;
      }
      case 'info': {
        if (!file) break;
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
    }
    console.log(USAGE);
    return cmd && cmd !== 'help' ? 1 : 0;
  } catch (e) {
    console.error(e instanceof ProjectFormatError ? e.message : `Error: ${(e as Error).message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) main().then((code) => { if (!['serve', 'worker'].includes(process.argv[2] ?? '')) process.exit(code); else if (code) process.exit(code); });
