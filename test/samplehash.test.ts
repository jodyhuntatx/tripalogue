import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { SAMPLE_BYTES, sampleRanges } from '../src/core/samplehash.js';
import { sampleHashOfFile } from '../src/server/samplehash.js';
import { mediaFiles, sampleHash } from '../src/web/uploader.js';

describe('sample hash (MM-7)', () => {
  it('reads the whole of a small file, and start, middle and end of a big one', () => {
    assert.deepEqual(sampleRanges(1000), [[0, 1000]]);
    assert.deepEqual(sampleRanges(3 * SAMPLE_BYTES), [[0, 3 * SAMPLE_BYTES]]);
    const big = 100 * 1024 * 1024;
    assert.deepEqual(sampleRanges(big), [[0, SAMPLE_BYTES], [big / 2 - SAMPLE_BYTES / 2, big / 2 + SAMPLE_BYTES / 2], [big - SAMPLE_BYTES, big]]);
  });

  it('gives the same answer in the browser and on the server, and changes with the content', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-sample-'));
    try {
      for (const size of [0, 5, 3 * SAMPLE_BYTES, 3 * SAMPLE_BYTES + 1, 20 * 1024 * 1024 + 7]) {
        const data = randomBytes(size);
        const f = path.join(dir, `f${size}`);
        await fs.writeFile(f, data);
        const server = await sampleHashOfFile(f);
        assert.equal(await sampleHash(new Blob([data])), server, `size ${size}`);
        if (size > 10) {
          const changed = Buffer.from(data);
          changed[size - 1] ^= 0xff; // the last byte is always sampled
          assert.notEqual(await sampleHash(new Blob([changed])), server);
        }
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps only media files from a picked or dropped folder', () => {
    const f = (name: string) => new File([new Uint8Array(1)], name);
    const kept = mediaFiles([f('IMG_1.HEIC'), f('.DS_Store'), f('._IMG_1.HEIC'), f('notes.txt'), f('Thumbs.db'), f('clip.MOV'), f('memo.m4a')]).map((x) => x.name);
    assert.deepEqual(kept, ['IMG_1.HEIC', 'clip.MOV', 'memo.m4a']);
  });
});
