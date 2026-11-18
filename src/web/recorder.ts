/**
 * AU-5: record narration in the browser. Each recording is a take, kept in the dialog to listen to; "Use this
 * take" uploads it like any other audio file and, once TripAlogue has measured it, puts it on the Narration lane
 * where the recording started. The picture plays (silently) while you record, so you can talk over it.
 */
import { buildTimeline, placeAudio, type Id } from '../core/index.js';
import { h, fill } from './dom.js';
import type { ProjectSession } from './session.js';
import { uploadFile } from './uploader.js';
import type { Player } from '../player/player.js';

interface Take {
  n: number;
  blob: Blob;
  url: string;
  startSec: number;
  seconds: number;
}

export interface Recorder {
  open(): void;
  dialog: HTMLDialogElement;
}

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** The recording format this browser offers, and the file extension TripAlogue reads it as. */
function format(): { mime: string; ext: string } {
  const want: [string, string][] = [['audio/webm;codecs=opus', 'weba'], ['audio/webm', 'weba'], ['audio/mp4', 'm4a'], ['audio/ogg;codecs=opus', 'ogg']];
  for (const [mime, ext] of want) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  return { mime: '', ext: 'weba' };
}

export function mountRecorder(s: ProjectSession, projectId: string, player: Player): Recorder {
  const takes: Take[] = [];
  let rec: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let startedAt = 0;
  let startSec = 0;
  let tick = 0;
  let wasMuted = false;
  let busy = '';
  const dialog = h('dialog', { class: 'rec-dialog', id: 'rec-dialog', 'aria-label': 'Record narration' }) as HTMLDialogElement;
  document.body.append(dialog);

  function render() {
    const recording = !!rec;
    const narration = s.state.audioLanes.find((l) => l.kind === 'narration');
    fill(dialog,
      h('h3', {}, 'Record narration'),
      h('p', { class: 'muted small' }, recording
        ? 'Recording. The picture plays without sound so you can talk over it.'
        : `Recording starts at ${fmt(player.time)}, where the playhead is. The picture plays silently while you talk.`),
      h('div', { class: 'row' },
        recording
          ? h('button', { id: 'rec-stop', class: 'primary', onclick: () => stop() }, `■ Stop (${fmt((performance.now() - startedAt) / 1000)})`)
          : h('button', { id: 'rec-start', class: 'primary', disabled: !s.canEdit || !!busy, onclick: () => void start() }, takes.length ? '● Record another take' : '● Record'),
        h('span', { class: 'spacer' }),
        h('button', { id: 'rec-close', disabled: recording, onclick: () => dialog.close() }, 'Close')),
      busy && h('p', { class: 'small', id: 'rec-status' }, busy),
      takes.length > 0 && h('ul', { class: 'rec-takes' }, ...takes.slice().reverse().map((t) => h('li', { 'data-take': String(t.n) },
        h('strong', {}, `Take ${t.n}`), h('span', { class: 'small muted' }, ` ${t.seconds.toFixed(1)} s from ${fmt(t.startSec)}`),
        h('audio', { controls: true, src: t.url, preload: 'metadata' }),
        h('div', { class: 'row' },
          h('button', { class: 'rec-use', disabled: !s.canEdit || !!busy || !narration, onclick: () => void use(t) }, 'Use this take'),
          h('button', { class: 'rec-discard', disabled: !!busy, onclick: () => { URL.revokeObjectURL(t.url); takes.splice(takes.indexOf(t), 1); render(); } }, 'Discard'))))),
      !takes.length && !recording && h('p', { class: 'muted small' }, 'Takes you record stay here until you use or discard them.'));
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      busy = `The microphone is not available: ${(e as Error).message}`;
      render();
      return;
    }
    busy = '';
    const f = format();
    const chunks: Blob[] = [];
    rec = new MediaRecorder(stream, f.mime ? { mimeType: f.mime } : undefined);
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const seconds = (performance.now() - startedAt) / 1000;
      const blob = new Blob(chunks, { type: rec?.mimeType || f.mime || 'audio/webm' });
      const n = (takes.at(-1)?.n ?? 0) + 1;
      takes.push({ n, blob, url: URL.createObjectURL(blob), startSec, seconds });
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      rec = null;
      clearInterval(tick);
      player.pause();
      player.setMuted(wasMuted);
      player.seek(startSec);
      render();
    };
    startSec = player.time;
    startedAt = performance.now();
    rec.start(250);
    wasMuted = player.muted;
    player.setMuted(true);
    player.play();
    tick = window.setInterval(render, 500);
    render();
  }

  function stop() {
    rec?.stop();
  }

  async function use(t: Take) {
    const narration = s.state.audioLanes.find((l) => l.kind === 'narration');
    if (!narration) return;
    const ext = format().ext;
    const file = new File([t.blob], `Narration take ${t.n} ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`, { type: t.blob.type, lastModified: Date.now() });
    busy = `Uploading take ${t.n}…`;
    render();
    let mediaId: Id;
    try {
      mediaId = await uploadFile(projectId, file);
    } catch (e) {
      busy = `The take could not be uploaded: ${(e as Error).message}`;
      render();
      return;
    }
    busy = `Measuring take ${t.n}…`;
    render();
    // Wait for TripAlogue to read the recording's length (it arrives with the next update of the project).
    const placed = await new Promise<boolean>((resolve) => {
      let done = false;
      let unsub = () => {};
      let poll = 0;
      let timer = 0;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        unsub();
        clearInterval(poll);
        clearTimeout(timer);
        resolve(ok);
      };
      const check = () => {
        const m = s.state.media.find((x) => x.id === mediaId);
        if (done || !m) return;
        if (m.status === 'failed') return finish(false);
        if (m.durationSec === undefined) return;
        // Finish first: the edit below notifies subscribers, which would call this again.
        finish(true);
        s.edit(`Narration take ${t.n}`, (q) => placeAudio(q, mediaId, narration.id, t.startSec, undefined, buildTimeline(q)));
      };
      unsub = s.subscribe(check);
      poll = window.setInterval(() => { void s.poll().then(check); }, 1000);
      timer = window.setTimeout(() => finish(false), 60_000);
      check();
    });
    if (placed) {
      URL.revokeObjectURL(t.url);
      takes.splice(takes.indexOf(t), 1);
      busy = `Take ${t.n} is on the Narration lane at ${fmt(t.startSec)}.`;
    } else busy = `Take ${t.n} was uploaded but could not be read yet; it is in the Media view's audio.`;
    render();
  }

  return {
    dialog,
    open() {
      render();
      if (!dialog.open) dialog.showModal();
    },
  };
}
