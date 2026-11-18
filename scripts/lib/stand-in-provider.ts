/**
 * A stand-in map provider for tests: Nominatim-style place search over a few Portuguese towns, and map tiles
 * drawn as plain coloured squares with a grid (no internet needed).
 */
import http from 'node:http';
import { crc32, deflateSync } from 'node:zlib';

export const PLACES: Record<string, [string, string, number, number]> = {
  lisbon: ['Lisboa', 'Lisboa, Lisbon, Portugal', 38.7077, -9.1365],
  sintra: ['Sintra', 'Sintra, Lisbon, Portugal', 38.8029, -9.3817],
  porto: ['Porto', 'Porto, Portugal', 41.1579, -8.6291],
  pinhao: ['Pinhão', 'Pinhão, Alijó, Vila Real, Portugal', 41.1906, -7.5458],
  coimbra: ['Coimbra', 'Coimbra, Portugal', 40.2111, -8.4291],
  evora: ['Évora', 'Évora, Portugal', 38.5714, -7.9135],
  lagos: ['Lagos', 'Lagos, Faro, Portugal', 37.1028, -8.6730],
  nazare: ['Nazaré', 'Nazaré, Leiria, Portugal', 39.6012, -9.0700],
};
function png(z: number, x: number, y: number): Buffer {
  const w = 256;
  const raw = Buffer.alloc((w * 3 + 1) * w);
  const base = [[52, 72, 92], [58, 84, 66], [70, 80, 60]][(x + y + z) % 3];
  for (let r = 0; r < w; r++) {
    raw[r * (w * 3 + 1)] = 0;
    for (let c = 0; c < w; c++) {
      const line = r % 64 === 0 || c % 64 === 0;
      const o = r * (w * 3 + 1) + 1 + c * 3;
      raw[o] = line ? base[0] + 30 : base[0];
      raw[o + 1] = line ? base[1] + 30 : base[1];
      raw[o + 2] = line ? base[2] + 30 : base[2];
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export async function startStandInProvider(): Promise<{ url: string; server: http.Server }> {
const provider = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/search') {
    const q = (u.searchParams.get('q') ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const hits = Object.entries(PLACES).filter(([k]) => q.includes(k)).map(([, [name, display, lat, lon]]) => ({ name, display_name: display, lat: String(lat), lon: String(lon), type: 'city' }));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(hits));
  }
  const t = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(u.pathname);
  if (t) {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(png(+t[1], +t[2], +t[3]));
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
return { url: providerUrl, server: provider };
}
