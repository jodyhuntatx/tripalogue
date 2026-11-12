import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { samplePrefix, sampleRanges } from '../core/samplehash.js';

/** Sample hash of a file on disk (see core/samplehash.ts). */
export async function sampleHashOfFile(file: string): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const h = createHash('sha256').update(samplePrefix(size));
    for (const [a, b] of sampleRanges(size)) {
      const buf = Buffer.alloc(b - a);
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, a + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      h.update(buf.subarray(0, got));
    }
    return h.digest('hex');
  } finally {
    await fh.close();
  }
}
