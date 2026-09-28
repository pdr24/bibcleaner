// Generates the toolbar icons (blue-pencil square with a check mark) as PNGs.
// Pure Node, no dependencies, so the icons are reproducible from source.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax,
    dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function icon(size) {
  const bg = [37, 83, 179];
  const ss = 4; // supersampling
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.22;
  const stroke = size * 0.11;
  const pts = [
    [0.26, 0.53],
    [0.43, 0.7],
    [0.75, 0.33],
  ].map(([x, y]) => [x * size, y * size]);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let inBox = 0,
        inCheck = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss,
            py = y + (sy + 0.5) / ss;
          const cx = Math.min(Math.max(px, r), size - r),
            cy = Math.min(Math.max(py, r), size - r);
          if (Math.hypot(px - cx, py - cy) <= r) inBox++;
          const d = Math.min(segDist(px, py, ...pts[0], ...pts[1]), segDist(px, py, ...pts[1], ...pts[2]));
          if (d <= stroke / 2) inCheck++;
        }
      const a = inBox / (ss * ss),
        c = inCheck / (ss * ss);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(bg[0] * (1 - c) + 255 * c);
      raw[o + 1] = Math.round(bg[1] * (1 - c) + 255 * c);
      raw[o + 2] = Math.round(bg[2] * (1 - c) + 255 * c);
      raw[o + 3] = Math.round(255 * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('extension/icons', { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`extension/icons/icon${s}.png`, icon(s));
console.log('icons written');
