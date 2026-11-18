/**
 * MP4 exports (VX-3, VX-4, VX-10): queued in the database, rendered one at a
 * time in the background on this computer, from a snapshot of the travelogue
 * taken when the export was started, so editing can go on meanwhile.
 *
 * Each export keeps its snapshot and title cards in a work folder until it
 * finishes, so a queued or interrupted export starts again when TripAlogue
 * does. Finished files go to <data>/exports/<project>/<export>/<name>.mp4.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  buildTimeline, exportFileName, resolveRange, settingsProblem, type ExportSettings, type Travelogue,
} from '../core/index.js';
import type { BlobStore } from './blobstore.js';
import type { ServerConfig } from './config.js';
import type { Db } from './db.js';
import { HttpError } from './http.js';
import type { Projects } from './projects.js';
import { RenderError, Renderer, type RenderOptions } from './render.js';
import { newId } from './auth.js';

export type ExportStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ExportInfo {
  id: string;
  projectId: string;
  rev: number;
  name: string;
  settings: ExportSettings;
  status: ExportStatus;
  progress: number;
  step: string | null;
  /** Seconds left, estimated from progress so far (running exports only). */
  etaSec: number | null;
  error: { message: string; itemId?: string; reason?: string } | null;
  bytes: number | null;
  durationSec: number | null;
  /** Where the finished file is on this computer. */
  path: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  seen: boolean;
}

interface Row {
  id: string; project_id: string; rev: number; name: string; settings: string; status: ExportStatus; progress: number; step: string | null;
  eta_sec: number | null; error: string | null; bytes: number | null; duration_sec: number | null; created_at: number;
  started_at: number | null; finished_at: number | null; seen: number;
}

/** An export request is small (its settings). */
export const MAX_EXPORT_REQUEST_BYTES = 64 * 1024;

export class Exports {
  readonly renderer: Renderer;
  private current: { id: string; abort: AbortController } | null = null;
  private running = false;
  private stopped = true;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly db: Db, private readonly cfg: ServerConfig, blobs: BlobStore, private readonly projects: Projects,
    options: Pick<RenderOptions, 'serverUrl' | 'tiles' | 'concurrency'>,
  ) {
    this.renderer = new Renderer(blobs, { ffmpeg: cfg.ffmpeg, ffprobe: cfg.ffprobe, log: cfg.log, ...options });
  }

  private get root() { return path.join(this.cfg.dataDir, 'exports'); }
  private workDir(id: string) { return path.join(this.root, 'work', id); }
  /** Each export in its own folder, under its readable name ("Portugal - 1080p.mp4"). */
  private outDir(projectId: string, id: string) { return path.join(this.root, projectId, id); }
  private outFile(projectId: string, id: string, name: string) { return path.join(this.outDir(projectId, id), name); }

  /** Start the background renderer; exports left queued or running by an earlier run start again. */
  start(): void {
    this.stopped = false;
    this.db.run("UPDATE exports SET status = 'queued', progress = 0, step = NULL, eta_sec = NULL WHERE status = 'running'");
    this.kick();
  }

  /** Stop after aborting the export in progress (it stays queued, so it runs again next start). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.current) {
      const id = this.current.id;
      this.current.abort.abort();
      await this.idle();
      this.db.run("UPDATE exports SET status = 'queued', progress = 0, step = NULL, eta_sec = NULL WHERE id = ? AND status IN ('running','cancelled') AND error IS NULL", id);
    }
  }

  idle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /** Queue an export of the travelogue as it is now. */
  async create(projectId: string, settingsIn: unknown): Promise<ExportInfo> {
    const settings = settingsIn as ExportSettings;
    const problem = settingsProblem(settings);
    if (problem) throw new HttpError(400, `Export ${problem}`, 'invalid');
    const { doc, rev } = this.projects.load(projectId);
    const tl = buildTimeline(doc);
    let range: { start: number; end: number };
    try {
      range = resolveRange(tl, settings.range);
    } catch (e) {
      throw new HttpError(400, (e as Error).message, 'invalid');
    }
    if (!(range.end - range.start > 0)) throw new HttpError(400, 'There is nothing to export in that part of the travelogue', 'empty');
    const id = newId('exp');
    const work = this.workDir(id);
    await fs.mkdir(work, { recursive: true });
    await fs.writeFile(path.join(work, 'project.json'), JSON.stringify(doc));
    const name = exportFileName(doc.title, tl, settings);
    this.db.run(
      "INSERT INTO exports (id, project_id, rev, name, settings, status, progress, created_at) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?)",
      id, projectId, rev, name, JSON.stringify(settings), Date.now(),
    );
    this.kick();
    return this.get(projectId, id);
  }

  list(projectId: string): ExportInfo[] {
    return this.db.all<Row>('SELECT * FROM exports WHERE project_id = ? ORDER BY created_at DESC', projectId).map((r) => this.info(r));
  }

  /** Finished exports the person has not opened yet, across travelogues (the "ready" notice). */
  unseen(): ExportInfo[] {
    return this.db.all<Row>("SELECT * FROM exports WHERE status IN ('done','failed') AND seen = 0 ORDER BY finished_at DESC").map((r) => this.info(r));
  }

  get(projectId: string, id: string): ExportInfo {
    const r = this.db.get<Row>('SELECT * FROM exports WHERE id = ? AND project_id = ?', id, projectId);
    if (!r) throw new HttpError(404, 'No such export', 'not_found');
    return this.info(r);
  }

  markSeen(projectId: string, id: string): ExportInfo {
    this.get(projectId, id);
    this.db.run('UPDATE exports SET seen = 1 WHERE id = ?', id);
    return this.get(projectId, id);
  }

  cancel(projectId: string, id: string): ExportInfo {
    const e = this.get(projectId, id);
    if (e.status === 'queued') {
      this.db.run("UPDATE exports SET status = 'cancelled', finished_at = ?, seen = 1 WHERE id = ?", Date.now(), id);
      void fs.rm(this.workDir(id), { recursive: true, force: true });
    } else if (e.status === 'running' && this.current?.id === id) {
      this.db.run("UPDATE exports SET status = 'cancelled' WHERE id = ?", id);
      this.current.abort.abort();
    }
    return this.get(projectId, id);
  }

  /** Delete an export and its file (cancelling it first if it is still going). */
  async remove(projectId: string, id: string): Promise<void> {
    const e = this.get(projectId, id);
    if (e.status === 'running' || e.status === 'queued') {
      this.cancel(projectId, id);
      await this.idle();
    }
    this.db.run('DELETE FROM exports WHERE id = ?', id);
    await fs.rm(this.outDir(projectId, id), { recursive: true, force: true });
    await fs.rm(this.workDir(id), { recursive: true, force: true });
  }

  /** The finished file, for download. */
  async file(projectId: string, id: string): Promise<{ path: string; name: string; size: number }> {
    const e = this.get(projectId, id);
    if (e.status !== 'done') throw new HttpError(409, 'This export is not finished', 'not_ready');
    const p = this.outFile(projectId, id, e.name);
    try {
      const st = await fs.stat(p);
      return { path: p, name: e.name, size: st.size };
    } catch {
      throw new HttpError(404, 'The exported file is no longer on this computer', 'gone');
    }
  }

  /** Everything a deleted travelogue exported goes with it. */
  async deleteProject(projectId: string): Promise<void> {
    for (const e of this.list(projectId)) if (e.status === 'running' || e.status === 'queued') this.cancel(projectId, e.id);
    await this.idle();
    for (const e of this.db.all<{ id: string }>('SELECT id FROM exports WHERE project_id = ?', projectId)) {
      await fs.rm(this.workDir(e.id), { recursive: true, force: true });
    }
    this.db.run('DELETE FROM exports WHERE project_id = ?', projectId);
    await fs.rm(path.join(this.root, projectId), { recursive: true, force: true });
  }

  private info(r: Row): ExportInfo {
    return {
      id: r.id, projectId: r.project_id, rev: r.rev, name: r.name, settings: JSON.parse(r.settings) as ExportSettings,
      status: r.status, progress: r.progress, step: r.step, etaSec: r.status === 'running' ? r.eta_sec : null,
      error: r.error ? (JSON.parse(r.error) as ExportInfo['error']) : null, bytes: r.bytes, durationSec: r.duration_sec,
      path: r.status === 'done' ? this.outFile(r.project_id, r.id, r.name) : null,
      createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, seen: !!r.seen,
    };
  }

  private kick(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    void this.drain().finally(() => {
      this.running = false;
      for (const w of this.idleWaiters.splice(0)) w();
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const row = this.db.get<Row>("SELECT * FROM exports WHERE status = 'queued' ORDER BY created_at LIMIT 1");
      if (!row) return;
      await this.runOne(row);
    }
  }

  private async runOne(row: Row): Promise<void> {
    const id = row.id;
    const work = this.workDir(id);
    const abort = new AbortController();
    this.current = { id, abort };
    const startedAt = Date.now();
    this.db.run("UPDATE exports SET status = 'running', started_at = ?, progress = 0, step = 'Starting', error = NULL WHERE id = ?", startedAt, id);
    let lastWrite = 0;
    try {
      const doc = JSON.parse(await fs.readFile(path.join(work, 'project.json'), 'utf8')) as Travelogue;
      const out = this.outFile(row.project_id, id, row.name);
      await fs.mkdir(path.dirname(out), { recursive: true });
      const result = await this.renderer.render({
        doc, settings: JSON.parse(row.settings) as ExportSettings, outFile: out, workDir: path.join(work, 'render'), signal: abort.signal,
        onProgress: (fraction, step) => {
          const now = Date.now();
          if (now - lastWrite < 400 && fraction < 1) return;
          lastWrite = now;
          const elapsed = (now - startedAt) / 1000;
          const eta = fraction > 0.02 ? Math.max(0, (elapsed / fraction) * (1 - fraction)) : null;
          this.db.run("UPDATE exports SET progress = ?, step = ?, eta_sec = ? WHERE id = ? AND status = 'running'", fraction, step, eta, id);
        },
      });
      const st = await fs.stat(out);
      this.db.run(
        "UPDATE exports SET status = 'done', progress = 1, step = NULL, eta_sec = NULL, bytes = ?, duration_sec = ?, finished_at = ?, seen = 0 WHERE id = ?",
        st.size, result.durationSec, Date.now(), id,
      );
      await fs.rm(work, { recursive: true, force: true });
    } catch (e) {
      const status = this.db.get<{ status: ExportStatus }>('SELECT status FROM exports WHERE id = ?', id)?.status;
      if (this.stopped && !(status === 'cancelled')) {
        // Shutting down: leave it to start again next time.
        this.db.run("UPDATE exports SET status = 'queued', progress = 0, step = NULL, eta_sec = NULL WHERE id = ?", id);
      } else if (status === 'cancelled' || (e instanceof RenderError && e.reason === 'cancelled')) {
        this.db.run("UPDATE exports SET status = 'cancelled', step = NULL, eta_sec = NULL, finished_at = ?, seen = 1 WHERE id = ?", Date.now(), id);
        await fs.rm(work, { recursive: true, force: true });
      } else {
        const err = e instanceof RenderError ? { message: e.message, itemId: e.itemId, reason: e.reason } : { message: `Export failed: ${(e as Error).message ?? e}` };
        if (!(e instanceof RenderError)) this.cfg.log(`export ${id} failed: ${(e as Error).stack ?? e}`);
        this.db.run("UPDATE exports SET status = 'failed', step = NULL, eta_sec = NULL, error = ?, finished_at = ?, seen = 0 WHERE id = ?", JSON.stringify(err), Date.now(), id);
        await fs.rm(path.join(work, 'render'), { recursive: true, force: true });
      }
      await fs.rm(`${this.outFile(row.project_id, id, row.name)}.part.mp4`, { force: true });
    } finally {
      this.current = null;
    }
  }
}
