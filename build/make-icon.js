const fs = require('fs');
const zlib = require('zlib');
const W = 256, H = 256;
const px = Buffer.alloc(W * H * 4);
function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = a;
}
// rounded square background gradient green->blue
const R = 56;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  // rounded corners
  let inside = true;
  const cx = x < R ? R : x > W - R ? W - R : x;
  const cy = y < R ? R : y > H - R ? H - R : y;
  const dx = x - cx, dy = y - cy;
  if (dx * dx + dy * dy > R * R) inside = false;
  if (!inside) { set(x, y, 0, 0, 0, 0); continue; }
  const t = (x + y) / (W + H);
  set(x, y, Math.round(16 + 10 * t), Math.round(185 - 60 * t), Math.round(129 + 70 * t));
}
// white forward arrow ">>" plus line
function thickLine(x0, y0, x1, y1, w, col) {
  const steps = 400;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    for (let ox = -w; ox <= w; ox++) for (let oy = -w; oy <= w; oy++) {
      if (ox * ox + oy * oy <= w * w) set(Math.round(x + ox), Math.round(y + oy), col[0], col[1], col[2], 255);
    }
  }
}
const W_ = [255, 255, 255];
// chat bubble outline (rounded rect)
function rect(x0, y0, x1, y1, w, col) {
  thickLine(x0, y0, x1, y0, w, col); thickLine(x1, y0, x1, y1, w, col);
  thickLine(x1, y1, x0, y1, w, col); thickLine(x0, y1, x0, y0, w, col);
}
rect(48, 62, 208, 168, 6, W_);
// bubble tail
thickLine(70, 168, 56, 200, 6, W_);
thickLine(56, 200, 96, 168, 6, W_);
// two arrows
thickLine(78, 100, 118, 128, 7, W_);
thickLine(118, 128, 78, 156, 7, W_);
thickLine(128, 100, 168, 128, 7, W_);
thickLine(168, 128, 128, 156, 7, W_);

// ---- write PNG ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, c]);
}
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);
fs.writeFileSync('build/icon.png', png);

// ---- ICO wrapper (PNG inside) ----
const ico = Buffer.alloc(6 + 16);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 0; ico[7] = 0; ico[8] = 0; ico[9] = 0;
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.writeFileSync('build/icon.ico', Buffer.concat([ico, png]));
console.log('icon written', png.length);
