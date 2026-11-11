/**
 * Project storage on the local file system (F-1).
 *
 * - Saves are atomic: write a temp file, fsync, rename over the target, so a
 *   crash mid-save never leaves a half-written project.
 * - Autosaves go to a sidecar `<file>.autosave` and never touch the user's
 *   explicitly saved file. On open, a sidecar newer than the main file is
 *   offered as crash recovery.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseProject, serializeProject, touch } from '../core/project.js';
import type { Travelogue } from '../core/schema.js';
import type { ValidationIssue } from '../core/validate.js';

export const autosavePath = (file: string) => `${file}.autosave`;

export async function writeAtomic(file: string, text: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

export async function saveProject(file: string, p: Travelogue): Promise<Travelogue> {
  const saved = touch(p);
  await writeAtomic(file, serializeProject(saved));
  await fs.rm(autosavePath(file), { force: true });
  return saved;
}

export async function autosaveProject(file: string, p: Travelogue): Promise<void> {
  await writeAtomic(autosavePath(file), serializeProject(touch(p)));
}

export interface OpenResult {
  project: Travelogue;
  warnings: ValidationIssue[];
  migratedFrom?: number;
  /** Present when an autosave newer than the saved file exists. */
  recovery?: { project: Travelogue; savedAt: Date };
}

export async function openProject(file: string): Promise<OpenResult> {
  const text = await fs.readFile(file, 'utf8');
  const result: OpenResult = parseProject(text);
  const side = autosavePath(file);
  try {
    const [mainStat, sideStat] = await Promise.all([fs.stat(file), fs.stat(side)]);
    if (sideStat.mtimeMs > mainStat.mtimeMs) {
      const sideText = await fs.readFile(side, 'utf8');
      try {
        const rec = parseProject(sideText).project;
        if (serializeProject({ ...rec, updatedAt: '' }) !== serializeProject({ ...result.project, updatedAt: '' })) {
          result.recovery = { project: rec, savedAt: sideStat.mtime };
        }
      } catch {
        /* a corrupt autosave is ignored; the saved file still opens */
      }
    }
  } catch {
    /* no sidecar */
  }
  return result;
}

export async function discardRecovery(file: string): Promise<void> {
  await fs.rm(autosavePath(file), { force: true });
}

/** Resolve a media item's file path from its source root (relative to the project file) and uri. */
export function resolveMediaPath(projectFile: string, sourceRoot: string | undefined, uri: string): string {
  const base = path.resolve(path.dirname(projectFile), sourceRoot ?? '.');
  return path.resolve(base, uri);
}
