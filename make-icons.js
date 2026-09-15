// Génère les icônes PNG (platine vue de dessus) sans dépendance.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

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
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c, dy = y + 0.5 - c;
      const r = Math.sqrt(dx * dx + dy * dy) / c;
      const a = Math.atan2(dy, dx);
      let col = [26, 28, 32];
      if (r < 0.9) col = [12, 12, 14];
      if (r < 0.88 && r > 0.4 && Math.sin(r * 90) > 0.6) col = [22, 22, 26];
      if (r < 0.86 && r > 0.42 && Math.abs(Math.sin(a * 1 + 0.6)) < 0.18) col = [40, 40, 46];
      if (r < 0.38) col = [255, 106, 0];
      if (r < 0.36 && r > 0.2 && Math.abs(Math.cos(a)) > 0.92 && dx > 0) col = [20, 20, 20];
      if (r < 0.05) col = [200, 200, 205];
      if (r < 0.9 && r > 0.88) col = [0, 230, 190];
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = col[0]; raw[i + 1] = col[1]; raw[i + 2] = col[2]; raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const out = path.join(__dirname, '..', 'public', 'icons');
for (const s of [180, 192, 512]) fs.writeFileSync(path.join(out, `icon-${s}.png`), png(s));
console.log('Icônes générées dans', out);
