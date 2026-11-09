#!/usr/bin/env node
// png2ico.js — wrap a PNG (ideally 256x256) into a valid Windows .ico file.
// PNG-in-ICO containers are supported from Windows Vista onward. No dependencies.
// Usage: node png2ico.js input.png output.ico
const fs = require('fs');

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('Usage: node png2ico.js input.png output.ico');
  process.exit(1);
}

const png = fs.readFileSync(input);
if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) {
  console.error('Input does not look like a PNG file.');
  process.exit(1);
}
// PNG width/height live in the IHDR chunk at fixed offsets 16/20
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width > 256 || height > 256) {
  console.warn(`Warning: ${width}x${height} exceeds 256px; Windows may ignore it. Resize to 256x256 first.`);
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);   // reserved
header.writeUInt16LE(1, 2);   // type: 1 = icon
header.writeUInt16LE(1, 4);   // image count

const entry = Buffer.alloc(16);
entry.writeUInt8(width >= 256 ? 0 : width, 0);    // 0 means 256
entry.writeUInt8(height >= 256 ? 0 : height, 1);
entry.writeUInt8(0, 2);       // palette size
entry.writeUInt8(0, 3);       // reserved
entry.writeUInt16LE(1, 4);    // color planes
entry.writeUInt16LE(32, 6);   // bits per pixel
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);  // data offset: 6 header + 16 entry

fs.writeFileSync(output, Buffer.concat([header, entry, png]));
console.log(`Wrote ${output} (${png.length + 22} bytes, ${width}x${height})`);
