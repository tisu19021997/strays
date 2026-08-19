/*
 * The app icon, drawn rather than downloaded.
 *
 * A packaged app's icon is the first thing anyone sees, and a generic Electron
 * one says "this is a web page in a box". This draws a paw on the lane's own
 * dark plate, from a pixel grid and the palette the pets are painted with, so
 * the icon is made of the same material as the thing it opens.
 *
 * No dependencies: zlib is in Node, and a PNG is a header plus one zlib stream
 * of filtered scanlines. `iconutil` (macOS) turns the sizes into the .icns.
 *
 *   node tools/make-icon.js          # writes build/icon.png and build/icon.icns
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'build');

/*
 * A paw, 16 across, in the same idiom as the sprites: '.' is transparent and
 * every other character is a key into the palette below. Four toes and a pad —
 * the shape reads at 16px in a menu bar and at 1024 in a Dock.
 */
const PAW = [
  '................',
  '....111..111....',
  '....111..111....',
  '111.111..111.111',
  '111.111..111.111',
  '111..........111',
  '.11..........11.',
  '................',
  '....22222222....',
  '..222222222222..',
  '.22222222222222.',
  '.22222222222222.',
  '.22222222222222.',
  '..222222222222..',
  '....22222222....',
  '................',
];

const PAL = {
  1: '#ffd166', // Mutex's warm yellow — the toes
  2: '#ffb26b', // Heisenbug's orange — the pad
};
const PLATE = '#17181c';  // the same near-black every surface in the lane uses
const EDGE = '#2a2c34';

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/* an RGBA buffer, and the two ways anything gets drawn into it */
function canvas(size) {
  return { size, px: Buffer.alloc(size * size * 4) };
}
function put(c, x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  c.px[i] = r; c.px[i + 1] = g; c.px[i + 2] = b; c.px[i + 3] = a;
}
/* a rounded square, the shape macOS expects an icon to sit in */
function plate(c, inset, radius, colour) {
  const s = c.size, lo = inset, hi = s - inset - 1, rgb = hex(colour);
  for (let y = lo; y <= hi; y++) {
    for (let x = lo; x <= hi; x++) {
      const dx = Math.max(lo + radius - x, x - (hi - radius), 0);
      const dy = Math.max(lo + radius - y, y - (hi - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) put(c, x, y, rgb);
    }
  }
}

/* the paw, scaled up by whole pixels so it stays pixel art at every size */
function paw(c, scale, offX, offY) {
  for (let row = 0; row < PAW.length; row++) {
    for (let col = 0; col < PAW[row].length; col++) {
      const key = PAW[row][col];
      if (key === '.' || key === ' ') continue;
      const rgb = hex(PAL[key]);
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) put(c, offX + col * scale + dx, offY + row * scale + dy, rgb);
      }
    }
  }
}

function render(size) {
  const c = canvas(size);
  // margins that match the other icons in a Dock rather than filling the square
  const inset = Math.round(size * 0.06);
  plate(c, inset, Math.round(size * 0.22), EDGE);
  plate(c, inset + Math.max(1, Math.round(size * 0.012)), Math.round(size * 0.21), PLATE);

  const scale = Math.max(1, Math.floor((size * 0.66) / PAW.length));
  const span = scale * PAW.length;
  paw(c, scale, Math.round((size - span) / 2), Math.round((size - span) / 2));
  return c;
}

/* RGBA -> PNG. Filter 0 on every scanline; zlib does the rest. */
function png(c) {
  const raw = Buffer.alloc(c.size * (c.size * 4 + 1));
  for (let y = 0; y < c.size; y++) {
    raw[y * (c.size * 4 + 1)] = 0;
    c.px.copy(raw, y * (c.size * 4 + 1) + 1, y * c.size * 4, (y + 1) * c.size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.size, 0);
  ihdr.writeUInt32BE(c.size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.png'), png(render(1024)));

/*
 * .icns, for the app bundle. Every size is rendered rather than resampled from
 * one big one — nearest-neighbour scaling of pixel art by non-integer factors
 * turns crisp edges into porridge, and the small sizes are where an icon is
 * actually looked at.
 */
const ICONSET = path.join(OUT, 'icon.iconset');
fs.rmSync(ICONSET, { recursive: true, force: true });
fs.mkdirSync(ICONSET, { recursive: true });
for (const [size, name] of [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
]) fs.writeFileSync(path.join(ICONSET, name), png(render(size)));

try {
  execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', path.join(OUT, 'icon.icns')]);
  fs.rmSync(ICONSET, { recursive: true, force: true });
  console.log('wrote build/icon.png and build/icon.icns');
} catch (e) {
  console.log('wrote build/icon.png; iconutil is macOS-only, so no .icns here');
}
