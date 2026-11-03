/* Binary helpers shared by the browser worker and format regression tests. */
// 64 full 1024×1024 images, or more smaller images within the same pixel budget.
export const limits = Object.freeze({
  bytes: 40 * 1024 * 1024, images: 128, side: 4096, pixels: 64 * 1024 * 1024,
  packageBytes: 128 * 1024 * 1024, previewBytes: 320 * 1024 * 1024,
});
const marker = new Uint8Array([0x6a, 0xd4, 0x01]);
export const ktxSignature = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 13, 10, 26, 10]);
const text = new TextEncoder();
const matches = (data, offset, value) => offset >= 0 && offset + value.length <= data.length && value.every((byte, i) => data[offset + i] === byte);
const ascii = (data, offset, value) => matches(data, offset, text.encode(value));
export const equalBytes = (a, b) => a.length === b.length && matches(a, 0, b);
export const hex = (data) => [...data].map((byte) => byte.toString(16).padStart(2, '0')).join('');
export const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', data));

export function join(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  if (length > limits.previewBytes) throw new Error('This conversion exceeds the 320 MiB output limit. Try a smaller export.');
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export function varuint(value) {
  const bytes = [];
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7; } while (value);
  return new Uint8Array(bytes);
}

export function webpDimensions(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 20 || !ascii(data, 0, 'RIFF') || !ascii(data, 8, 'WEBP') || view.getUint32(4, true) + 8 !== data.length)
    throw new Error('Invalid embedded WebP image. Re-export the file from Rive.');
  let canvas = null;
  let image = null;
  const u24 = (offset) => data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
  for (let offset = 12; offset < data.length;) {
    if (offset + 8 > data.length) throw new Error('Truncated WebP image.');
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > data.length) throw new Error('Truncated WebP image.');
    let dimensions = null;
    if (ascii(data, offset, 'VP8X')) {
      if (size < 10 || canvas) throw new Error('Invalid extended WebP image.');
      if (data[start] & 2) throw new Error('Animated WebP images are not supported.');
      canvas = [u24(start + 4) + 1, u24(start + 7) + 1];
    } else if (ascii(data, offset, 'ANIM') || ascii(data, offset, 'ANMF')) {
      throw new Error('Animated WebP images are not supported.');
    } else if (ascii(data, offset, 'VP8L')) {
      if (size < 5 || data[start] !== 0x2f) throw new Error('Invalid lossless WebP image.');
      const bits = view.getUint32(start + 1, true);
      dimensions = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    } else if (ascii(data, offset, 'VP8 ')) {
      if (size < 10 || !matches(data, start + 3, [0x9d, 0x01, 0x2a])) throw new Error('Invalid lossy WebP image.');
      dimensions = [view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff];
    }
    if (dimensions) {
      if (image) throw new Error('Multiple image frames are not supported.');
      image = dimensions;
    }
    offset = start + size + (size % 2);
    if (offset > data.length) throw new Error('Invalid WebP padding.');
  }
  if (!image || image.some((side) => !side) || (canvas && (canvas[0] !== image[0] || canvas[1] !== image[1])))
    throw new Error('Unsupported or inconsistent WebP dimensions.');
  return image;
}

export function parseRive(data) {
  if (!data.length || data.length > limits.bytes) throw new Error('Choose a Rive export up to 40 MiB.');
  if (!ascii(data, 0, 'RIVE')) throw new Error('This is not an ordinary .riv export.');
  const images = [];
  let position = 4;
  let pixels = 0;
  while (position < data.length) {
    let start = position;
    while (start < data.length && !matches(data, start, marker)) start++;
    if (start === data.length) break;
    position = start + marker.length;
    let cursor = position, size = 0, shift = 0;
    while (true) {
      if (cursor >= data.length || shift > 28) throw new Error('Invalid Rive image length.');
      const value = data[cursor++];
      size += (value & 127) * 2 ** shift;
      if (value < 128) break;
      shift += 7;
    }
    if (!ascii(data, cursor, 'RIFF') || !ascii(data, cursor + 8, 'WEBP')) continue;
    const end = cursor + size;
    if (end >= data.length || data[end] !== 0) throw new Error('Invalid embedded Rive image record.');
    const dimensions = webpDimensions(data.subarray(cursor, end));
    pixels += dimensions[0] * dimensions[1];
    if (dimensions.some((side) => side > limits.side) || pixels > limits.pixels)
      throw new Error('Images must be at most 4096 pixels per side and 67,108,864 pixels combined (64 images at 1024×1024).');
    images.push({ start, content: cursor, end, dimensions });
    if (images.length > limits.images) throw new Error(`This export exceeds the limit of ${limits.images} embedded images.`);
    position = end + 1;
  }
  if (!images.length) throw new Error('No embedded WebP images found. Embed WebP images in Rive and export again.');
  return images;
}

export function createKTX2(levels) {
  const header = new Uint8Array(80 + levels.length * 24 + 44);
  header.set(ktxSignature);
  const view = new DataView(header.buffer);
  const fields = [157, 1, levels[0].width, levels[0].height, 0, 0, 1, levels.length, 0, 80 + levels.length * 24, 44, 0, 0];
  fields.forEach((value, i) => view.setUint32(12 + i * 4, value, true));
  const dfd = 80 + levels.length * 24;
  view.setUint32(dfd, 44, true);
  view.setUint16(dfd + 8, 2, true);
  view.setUint16(dfd + 10, 40, true);
  header.set([162, 1, 1, 1, 3, 3, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0], dfd + 12);
  header.set([0, 0, 127, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255], dfd + 28);
  const parts = [header];
  let size = header.length;
  for (let i = levels.length - 1; i >= 0; i--) {
    const level = levels[i];
    if (level.blocks.length !== Math.ceil(level.width / 4) * Math.ceil(level.height / 4) * 16)
      throw new Error('The ASTC encoder produced an invalid texture.');
    const padding = (16 - size % 16) % 16;
    parts.push(new Uint8Array(padding), level.blocks);
    size += padding;
    view.setBigUint64(80 + i * 24, BigInt(size), true);
    view.setBigUint64(88 + i * 24, BigInt(level.blocks.length), true);
    view.setBigUint64(96 + i * 24, BigInt(level.blocks.length), true);
    size += level.blocks.length;
  }
  return join(parts);
}

export function replaceImages(data, images, textures) {
  const parts = [], replacementRanges = [];
  let cursor = 0, size = 0;
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const before = data.subarray(cursor, image.start);
    const replacement = join([marker, varuint(textures[i].length), textures[i]]);
    parts.push(before, replacement);
    replacementRanges.push([size + before.length, size + before.length + replacement.length, data.subarray(image.start, image.end)]);
    size += before.length + replacement.length;
    cursor = image.end;
  }
  parts.push(data.subarray(cursor));
  const result = join(parts);
  const restored = [];
  cursor = 0;
  for (const [start, end, original] of replacementRanges) {
    restored.push(result.subarray(cursor, start), original);
    cursor = end;
  }
  restored.push(result.subarray(cursor));
  if (!equalBytes(join(restored), data)) throw new Error('Rive authoring data preservation failed.');
  return result;
}

const crcTable = new Uint32Array(256).map((_, value) => {
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});
export function crc32(data) {
  let result = 0xffffffff;
  for (const byte of data) result = (result >>> 8) ^ crcTable[(result ^ byte) & 255];
  return (result ^ 0xffffffff) >>> 0;
}

export function makeZIP(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [filename, data] of files) {
    const name = text.encode(filename);
    const crc = crc32(data);
    const entry = new Uint8Array(30 + name.length);
    const view = new DataView(entry.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(12, 33, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    entry.set(name, 30);
    local.push(entry, data);
    const record = new Uint8Array(46 + name.length);
    const index = new DataView(record.buffer);
    index.setUint32(0, 0x02014b50, true);
    index.setUint16(4, 20, true);
    index.setUint16(6, 20, true);
    index.setUint16(14, 33, true);
    index.setUint32(16, crc, true);
    index.setUint32(20, data.length, true);
    index.setUint32(24, data.length, true);
    index.setUint16(28, name.length, true);
    index.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);
    offset += entry.length + data.length;
  }
  const directory = join(central);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, directory.length, true);
  view.setUint32(16, offset, true);
  return join([...local, directory, end]);
}
