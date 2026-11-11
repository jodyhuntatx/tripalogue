/**
 * Opt-in telemetry hooks for usability sessions (F-5).
 *
 * Off by default. When on, events carry only names, ids, counts, durations and
 * flags: never media content, file paths, URIs, titles or free text. Sinks
 * decide where events go (console, a session log file, a moderator's tool).
 */

export type TelemetryValue = number | boolean | string;
export interface TelemetryEvent {
  name: string;
  at: number;
  sessionId: string;
  props: Record<string, TelemetryValue>;
}
export type TelemetrySink = (e: TelemetryEvent) => void;

/** Keys that could leak content or location are dropped, whatever their value. */
const BLOCKED_KEY = /(uri|url|path|file|name|title|text|description|caption|location|lat|lng|coord|email|token)/i;
const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;

export function sanitize(props: Record<string, unknown>): Record<string, TelemetryValue> {
  const out: Record<string, TelemetryValue> = {};
  for (const [k, v] of Object.entries(props)) {
    if (BLOCKED_KEY.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 1000) / 1000;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && SAFE_STRING.test(v)) out[k] = v;
  }
  return out;
}

export class Telemetry {
  private enabled = false;
  private sinks = new Set<TelemetrySink>();
  private tasks = new Map<string, number>();
  readonly sessionId: string;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.sessionId = `s-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }
  /** Only an explicit user opt-in should call this. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.tasks.clear();
  }
  addSink(sink: TelemetrySink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  track(name: string, props: Record<string, unknown> = {}): void {
    if (!this.enabled || !SAFE_STRING.test(name)) return;
    const e: TelemetryEvent = { name, at: this.now(), sessionId: this.sessionId, props: sanitize(props) };
    for (const s of this.sinks) {
      try {
        s(e);
      } catch {
        /* a broken sink must never break the app */
      }
    }
  }

  /** Task timing for usability tasks, e.g. taskStart('G1.enter-trip'). */
  taskStart(task: string): void {
    if (!this.enabled) return;
    this.tasks.set(task, this.now());
    this.track('task_start', { task });
  }
  taskEnd(task: string, outcome: 'success' | 'fail' | 'abandon' = 'success'): void {
    if (!this.enabled) return;
    const started = this.tasks.get(task);
    this.tasks.delete(task);
    this.track('task_end', { task, outcome, durationMs: started === undefined ? -1 : this.now() - started });
  }
  error(code: string, props: Record<string, unknown> = {}): void {
    this.track('error', { code, ...props });
  }
}

/** Process-wide instance; tests and embedders may create their own. */
export const telemetry = new Telemetry();

/** A sink that keeps events in memory, for tests and for a session export. */
export function memorySink(): { sink: TelemetrySink; events: TelemetryEvent[] } {
  const events: TelemetryEvent[] = [];
  return { sink: (e) => events.push(e), events };
}
