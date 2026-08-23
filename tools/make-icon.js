/*
 * The app icon, built from the project's own logo.
 *
 * A packaged app's icon is the first thing anyone sees, and a generic Electron
 * one says "this is a web page in a box". The source is `build/logo.png` —
 * Heisenbug in her helmet, the mark the project is known by — and this turns it
 * into the sizes macOS wants.
 *
 * No dependencies: zlib is in Node, and a PNG is a header plus one zlib stream
 * of filtered scanlines, so decoding and re-encoding one is a page of code
 * rather than a package. `iconutil` (macOS) turns the sizes into the .icns.
 *
 *   node tools/make-icon.js          # writes build/icon.png and build/icon.icns
 *
 * This used to draw a paw from a pixel grid, and scaled it by whole pixels so
 * every size stayed crisp. That rule does not survive the change of source: the
 * logo is a 1254px raster whose art does not sit on an aligned block grid (the
 * export resampled it), so there is no integer factor to scale by and
 * nearest-neighbour would drop whole rows of pixels — at 16px that is not a
 * crisp icon, it is a broken one. Every size is therefore area-averaged from
 * the full-resolution source, over PREMULTIPLIED alpha: averaging straight RGBA
 * pulls the invisible black of fully-transparent pixels into every edge, which
 * shows up as a dark fringe around the whole mark on a light Dock.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'build');
const LOGO = path.join(OUT, 'logo.png');

/* ---------------------------------------------------------------- decode */
/* PNG -> { w, h, px } RGBA8. Handles the five scanline filters; the logo is
 * 8-bit truecolour+alpha and non-interlaced, which is what an export gives you.
 * Anything else is a loud failure rather than a silently wrong icon. */
function decode(file) {
  const d = fs.readFileSync(file);
  if (d.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);
  const w = d.readUInt32BE(16), h = d.readUInt32BE(20);
  const depth = d[24], colour = d[25], interlace = d[28];
  if (depth !== 8 || colour !== 6 || interlace !== 0)
    throw new Error(`${file}: need 8-bit RGBA, non-interlaced (got depth ${depth}, colour ${colour}, interlace ${interlace})`);

  let i = 8, idat = [];
  while (i < d.length) {
    const len = d.readUInt32BE(i), type = d.toString('ascii', i + 4, i + 8);
    if (type === 'IDAT') idat.push(d.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));

  const bpp = 4, stride = w * bpp, px = Buffer.alloc(w * h * bpp);
  let pos = 0, prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const line = Buffer.from(raw.subarray(pos, pos + stride)); pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else if (f !== 0) throw new Error(`${file}: bad filter ${f} on row ${y}`);
    }
    line.copy(px, y * stride);
    prev = line;
  }
  return { w, h, px };
}

/* ---------------------------------------------------------------- resize */
/* Area average over premultiplied alpha — see the note at the top for why the
 * premultiply is load-bearing rather than pedantry. */
function resize(src, size) {
  const { w, h, px } = src;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor((y * h) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / size));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * w) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / size));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * w + sx) * 4, al = px[i + 3] / 255;
          r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al; n++;
        }
      }
      const o = (y * size + x) * 4, mean = a / n;
      if (mean > 0) {
        out[o] = Math.min(255, Math.round(r / n / mean));
        out[o + 1] = Math.min(255, Math.round(g / n / mean));
        out[o + 2] = Math.min(255, Math.round(b / n / mean));
        out[o + 3] = Math.round(mean * 255);
      }
    }
  }
  return { size, px: out };
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

const logo = decode(LOGO);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.png'), png(resize(logo, 1024)));

const ICONSET = path.join(OUT, 'icon.iconset');
fs.rmSync(ICONSET, { recursive: true, force: true });
fs.mkdirSync(ICONSET, { recursive: true });
for (const [size, name] of [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
]) fs.writeFileSync(path.join(ICONSET, name), png(resize(logo, size)));

try {
  execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', path.join(OUT, 'icon.icns')]);
  fs.rmSync(ICONSET, { recursive: true, force: true });
  console.log('wrote build/icon.png and build/icon.icns from build/logo.png');
} catch (e) {
  console.log('wrote build/icon.png from build/logo.png; iconutil is macOS-only, so no .icns here');
}
