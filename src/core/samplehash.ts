/**
 * Sample hash (MM-7): a quick content fingerprint for spotting files that are
 * already uploaded without hashing whole videos in the browser. SHA-256 over
 * the size followed by up to 2 MiB from the start, the middle and the end of
 * the file (the whole file when it is 6 MiB or less). Computed the same way by
 * the browser (before uploading) and the server (for stored originals).
 */
export const SAMPLE_BYTES = 2 * 1024 * 1024;

/** The byte ranges [start, end) the sample hash reads, in order. */
export function sampleRanges(size: number): [number, number][] {
  if (size <= 3 * SAMPLE_BYTES) return [[0, size]];
  const mid = Math.floor(size / 2) - SAMPLE_BYTES / 2;
  return [[0, SAMPLE_BYTES], [mid, mid + SAMPLE_BYTES], [size - SAMPLE_BYTES, size]];
}

/** The prefix hashed before the samples. */
export const samplePrefix = (size: number) => new TextEncoder().encode(`tripalogue-sample-v1:${size}:`);
