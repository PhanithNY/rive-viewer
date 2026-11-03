/* Resource checks at the runtime's asset-loader boundary, before decoding. */
import { limits, webpDimensions } from './optimizer-core.js';

export const playbackLimits = Object.freeze({
  sourceBytes: limits.bytes, previewBytes: limits.previewBytes,
  assets: 256, images: limits.images, side: limits.side, pixels: limits.pixels,
  fontBytes: 4 * 1024 * 1024, audioBytes: 8 * 1024 * 1024,
  artboards: 64, tracks: 256, inputs: 1024,
});
const has = (bytes, offset, signature) => offset + signature.length <= bytes.length
  && signature.every((value, i) => bytes[offset + i] === value);

export function imageDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (has(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) {
    if (bytes.length < 33 || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
      throw new Error('Invalid PNG image header.');
    const dimensions = [view.getUint32(16), view.getUint32(20)];
    for (let offset = 8; offset < bytes.length;) {
      if (offset + 12 > bytes.length) throw new Error('Truncated PNG image.');
      const length = view.getUint32(offset), type = view.getUint32(offset + 4);
      if (offset + length + 12 > bytes.length) throw new Error('Truncated PNG image.');
      if (type === 0x6163544c) throw new Error('Animated images are not supported for safe playback.');
      if (offset !== 8 && type === 0x49484452) throw new Error('Duplicate PNG image header.');
      offset += length + 12;
      if (type === 0x49454e44) {
        if (length || offset !== bytes.length) throw new Error('Invalid PNG image ending.');
        return dimensions;
      }
    }
    throw new Error('Truncated PNG image.');
  }
  if (has(bytes, 0, [255, 216])) {
    for (let offset = 2; offset < bytes.length;) {
      if (bytes[offset++] !== 255) throw new Error('Invalid JPEG image marker.');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) throw new Error('Truncated JPEG image.');
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('Invalid JPEG image segment.');
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) throw new Error('Invalid JPEG image dimensions.');
        return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      }
      offset += length;
    }
    throw new Error('Unsupported JPEG image dimensions.');
  }
  if (has(bytes, 0, [82, 73, 70, 70]) && has(bytes, 8, [87, 69, 66, 80])) return webpDimensions(bytes);
  throw new Error('Safe playback supports embedded PNG, JPEG, and static WebP images.');
}

export function validatePlaybackBuffer(buffer) {
  if (!buffer.byteLength || buffer.byteLength > playbackLimits.previewBytes)
    throw new Error('The prepared preview exceeds the 320 MiB playback limit.');
  if (!has(new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength)), 0, [82, 73, 86, 69]))
    throw new Error('This is not a valid Rive export.');
}

export function createAssetBudget() {
  let assets = 0, images = 0, pixels = 0, embeddedBytes = 0;
  return (asset, bytes) => {
    if (++assets > playbackLimits.assets) throw new Error(`Playback supports at most ${playbackLimits.assets} assets.`);
    embeddedBytes += bytes.length;
    if (embeddedBytes > playbackLimits.previewBytes) throw new Error('Embedded assets exceed the playback byte limit.');
    if (asset.isImage && ++images > playbackLimits.images) throw new Error(`Playback supports at most ${playbackLimits.images} images.`);
    if (!bytes.length) return;
    if (asset.isImage) {
      const [width, height] = imageDimensions(bytes);
      pixels += width * height;
      if (!width || !height || width > playbackLimits.side || height > playbackLimits.side || pixels > playbackLimits.pixels)
        throw new Error('Playback images must be at most 4096 pixels per side and 67,108,864 pixels combined (64 images at 1024×1024).');
    } else if (asset.isFont && bytes.length > playbackLimits.fontBytes) {
      throw new Error('Playback fonts must be at most 4 MiB each.');
    } else if (asset.isAudio && bytes.length > playbackLimits.audioBytes) {
      throw new Error('Playback audio must be at most 8 MiB per asset.');
    }
  };
}

export function inspectPlaybackFile(runtime, file) {
  const count = file.artboardCount();
  if (!count || count > playbackLimits.artboards) throw new Error('Playback supports between 1 and 64 artboards.');
  let tracks = 0, inputs = 0;
  for (let i = 0; i < count; i++) {
    const artboard = file.artboardByIndex(i);
    try {
      const machines = artboard.stateMachineCount();
      tracks += machines + artboard.animationCount();
      if (tracks > playbackLimits.tracks) throw new Error('Playback supports at most 256 tracks combined.');
      for (let j = 0; j < machines; j++) {
        const machine = artboard.stateMachineByIndex(j);
        let instance;
        try {
          instance = new runtime.StateMachineInstance(machine, artboard);
          inputs += instance.inputCount();
          if (inputs > playbackLimits.inputs) throw new Error('Playback supports at most 1024 state machine inputs.');
        // The definition belongs to the artboard; only the instance is ours.
        } finally { instance?.delete(); }
      }
    } finally { artboard.delete(); }
  }
}
