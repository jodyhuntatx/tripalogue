/**
 * The export page's frame sender (VX-7): converts each drawn frame to YUV 4:2:0 and uploads it, one at a time and
 * in order, while the page draws the next one. Each message is answered when its upload is done.
 */
import { toYuv420 } from './yuv.js';

interface Job { url: string; rgba?: ArrayBuffer; w: number; h: number; headers: Record<string, string> }

let yuv: Uint8Array<ArrayBuffer> | null = null;
let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<Job>) => {
  queue = queue.then(async () => {
    const { url, rgba, w, h, headers } = e.data;
    try {
      let body: Uint8Array<ArrayBuffer> | undefined;
      if (rgba) {
        if (!yuv || yuv.length !== w * h * 1.5) yuv = new Uint8Array(w * h * 1.5);
        toYuv420(new Uint8ClampedArray(rgba), w, h, yuv);
        body = yuv;
      }
      const res = await fetch(url, { method: 'POST', headers, body });
      const reply = (await res.json().catch(() => ({}))) as { error?: string };
      postMessage({ ok: res.ok, error: reply.error });
    } catch (err) {
      postMessage({ ok: false, error: String((err as Error)?.message ?? err) });
    }
  });
};
