import { crc32, equalBytes, hex, join, ktxSignature, limits, sha256 } from './optimizer-core.js';

export const previewLimit = limits.packageBytes;
const text = new TextDecoder();
const magic = (data, offset, value) => offset + value.length <= data.length && text.decode(data.subarray(offset, offset + value.length)) === value;

export function inspectKTX2(data) {
  if (data.length < 104 || !equalBytes(data.subarray(0, 12), ktxSignature)) throw new Error('Invalid optimized texture.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(20, true), height = view.getUint32(24, true), levels = view.getUint32(40, true);
  if (view.getUint32(12, true) !== 157 || view.getUint32(16, true) !== 1 || !width || !height || width > limits.side || height > limits.side
      || view.getUint32(28, true) !== 0 || view.getUint32(32, true) !== 0 || view.getUint32(36, true) !== 1
      || view.getUint32(44, true) !== 0 || levels !== Math.floor(Math.log2(Math.max(width, height))) + 1
      || 80 + levels * 24 > data.length)
    throw new Error('This viewer supports 2D ASTC 4×4 packages produced by our optimizer.');
  const dfdOffset = view.getUint32(48, true), dfdLength = view.getUint32(52, true);
  if (dfdOffset < 80 + levels * 24 || dfdLength < 28 || dfdOffset + dfdLength > data.length
      || data[dfdOffset + 12] !== 162 || data[dfdOffset + 14] !== 1 || (data[dfdOffset + 15] & 1) !== 1)
    throw new Error('Unsupported optimized texture color or alpha format.');
  const ranges = [];
  for (let level = 0; level < levels; level++) {
    const offset = Number(view.getBigUint64(80 + level * 24, true));
    const size = Number(view.getBigUint64(88 + level * 24, true));
    const raw = Number(view.getBigUint64(96 + level * 24, true));
    const w = Math.max(1, width >> level), h = Math.max(1, height >> level);
    if (!Number.isSafeInteger(offset) || offset % 16 || offset < dfdOffset + dfdLength || size !== Math.ceil(w / 4) * Math.ceil(h / 4) * 16
        || raw !== size || offset + size > data.length || ranges.some(([start, end]) => offset < end && offset + size > start))
      throw new Error('Invalid optimized texture mipmap data.');
    ranges.push([offset, offset + size]);
  }
  return { width, height, blocks: data.subarray(...ranges[0]) };
}

export function packageImages(data) {
  if (!magic(data, 0, 'RIVE') || data.length > previewLimit) throw new Error('The optimized package contains invalid or oversized Rive data.');
  const result = [];
  let pixels = 0;
  for (let position = 4; position + 3 < data.length;) {
    let start = position;
    while (start + 3 < data.length && !(data[start] === 0x6a && data[start + 1] === 0xd4 && data[start + 2] === 1)) start++;
    if (start + 3 >= data.length) break;
    position = start + 3;
    let cursor = position, size = 0, shift = 0;
    while (true) {
      if (cursor >= data.length || shift > 28) throw new Error('Invalid optimized Rive image length.');
      const value = data[cursor++];
      size += (value & 127) * 2 ** shift;
      if (value < 128) break;
      shift += 7;
    }
    if (!equalBytes(data.subarray(cursor, cursor + 12), ktxSignature)) continue;
    const end = cursor + size;
    if (end >= data.length || data[end] !== 0) throw new Error('Truncated optimized Rive image.');
    const image = inspectKTX2(data.subarray(cursor, end));
    pixels += image.width * image.height;
    if (pixels > limits.pixels || result.length >= limits.images) throw new Error('This optimized file exceeds the safe browser preview image limits.');
    result.push({ start, content: cursor, end, ...image });
    position = end + 1;
  }
  if (!result.length) throw new Error('The package has no supported ASTC textures.');
  return result;
}

export async function readOptimizedZIP(data) {
  if (data.length > previewLimit) throw new Error('Choose an optimized package or ZIP up to 128 MiB.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557)) {
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === data.length) break;
    end--;
  }
  if (end < 0 || data.length - end > 65557 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('Invalid or unsupported optimized ZIP.');
  const count = view.getUint16(end + 10, true), centralSize = view.getUint32(end + 12, true), central = view.getUint32(end + 16, true);
  if (!count || count > 32 || view.getUint16(end + 8, true) !== count || central + centralSize !== end) throw new Error('Invalid or oversized ZIP directory.');
  const entries = [];
  let position = central;
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) throw new Error('Invalid ZIP directory entry.');
    const flags = view.getUint16(position + 8, true), method = view.getUint16(position + 10, true);
    const size = view.getUint32(position + 24, true), compressed = view.getUint32(position + 20, true);
    const nameLength = view.getUint16(position + 28, true), extra = view.getUint16(position + 30, true), comment = view.getUint16(position + 32, true);
    if (position + 46 + nameLength + extra + comment > end || view.getUint16(position + 34, true) || (flags & 1)) throw new Error('Encrypted or invalid ZIP entries are not supported.');
    const nameBytes = data.subarray(position + 46, position + 46 + nameLength);
    const name = text.decode(nameBytes);
    const offset = view.getUint32(position + 42, true);
    entries.push({ name, nameBytes, flags, method, size, compressed, offset, crc: view.getUint32(position + 16, true) });
    position += 46 + nameLength + extra + comment;
  }
  if (position !== end) throw new Error('Invalid ZIP directory length.');
  const candidates = entries.filter((entry) => /\.riv\.astc\.lzfse$/i.test(entry.name));
  if (candidates.length !== 1) throw new Error('Choose a ZIP containing exactly one .riv.astc.lzfse package.');
  async function extract(entry, maximum) {
    const { offset } = entry;
    if (entry.size > maximum || entry.compressed > previewLimit || (entry.method === 0 && entry.compressed !== entry.size)
        || offset + 30 > central || view.getUint32(offset, true) !== 0x04034b50
        || view.getUint16(offset + 6, true) !== entry.flags || view.getUint16(offset + 8, true) !== entry.method) throw new Error('Invalid or oversized ZIP file data.');
    const nameLength = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
    if (!equalBytes(data.subarray(offset + 30, offset + 30 + nameLength), entry.nameBytes)) throw new Error('Inconsistent ZIP filenames.');
    const start = offset + 30 + nameLength + extra;
    if (start + entry.compressed > central) throw new Error('Truncated ZIP entry.');
    const compressed = data.subarray(start, start + entry.compressed);
    let result;
    if (entry.method === 0) result = compressed.slice();
    else if (entry.method === 8 && globalThis.DecompressionStream) {
      let decompressor;
      try { decompressor = new DecompressionStream('deflate-raw'); }
      catch { throw new Error('Extract and open the .riv.astc.lzfse file; this browser cannot decompress this ZIP.'); }
      const reader = new Blob([compressed]).stream().pipeThrough(decompressor).getReader();
      const parts = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > entry.size || size > maximum) throw new Error('The ZIP expands beyond its declared size.');
          parts.push(part.value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      result = join(parts);
    } else throw new Error('This ZIP compression method is not supported by your browser. Extract and open the .riv.astc.lzfse file instead.');
    if (result.length !== entry.size || crc32(result) !== entry.crc) throw new Error('ZIP integrity check failed. Download the package again.');
    return result;
  }
  const entry = candidates[0];
  const packageData = await extract(entry, previewLimit);
  const manifestName = entry.name.slice(0, -11) + '.manifest.json';
  const manifests = entries.filter((candidate) => candidate.name === manifestName);
  if (manifests.length > 1) throw new Error('The ZIP contains duplicate manifests.');
  if (manifests.length) {
    const manifest = JSON.parse(text.decode(await extract(manifests[0], 65536)));
    if (typeof manifest.package_sha256 !== 'string' || hex(await sha256(packageData)) !== manifest.package_sha256
        || typeof manifest.source_sha256 !== 'string' || hex(packageData.subarray(8, 40)) !== manifest.source_sha256)
      throw new Error('The package does not match its manifest. Download the ZIP again.');
  }
  return packageData;
}
