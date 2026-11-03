import createEncoder from './vendor/optimizer/encoder.js';
import { equalBytes, replaceImages } from './optimizer-core.js';
import { packageImages, previewLimit, readOptimizedZIP } from './package-core.js';

const report = (stage) => self.postMessage({ type: 'progress', stage });
function allocate(encoder, size) {
  const pointer = encoder._malloc(size);
  if (!pointer) throw new Error('There is not enough browser memory to preview this package. Try a smaller export.');
  return pointer;
}
function unpack(encoder, data) {
  if (data.length < 44 || new TextDecoder().decode(data.subarray(0, 8)) !== 'RIVASTC1' || new TextDecoder().decode(data.subarray(-4)) !== 'bvx$') throw new Error('Invalid or truncated .riv.astc.lzfse package.');
  let input = 0, output = 0;
  try {
    input = allocate(encoder, data.length - 40);
    output = allocate(encoder, previewLimit + 1);
    encoder.HEAPU8.set(data.subarray(40), input);
    const size = encoder._decompress_lzfse(input, data.length - 40, output, previewLimit + 1);
    if (!size || size > previewLimit) throw new Error('The package is damaged or expands beyond the 128 MiB preview limit.');
    return encoder.HEAPU8.slice(output, output + size);
  } finally { for (const pointer of [input, output]) if (pointer) encoder._free(pointer); }
}
async function decodeImage(encoder, image) {
  let input = 0, output = 0;
  try {
    const size = image.width * image.height * 4;
    input = allocate(encoder, image.blocks.length);
    output = allocate(encoder, size);
    encoder.HEAPU8.set(image.blocks, input);
    if (encoder._decode_astc(input, image.blocks.length, image.width, image.height, output, size) !== size) throw new Error('An optimized texture could not be decoded.');
    const pixels = new Uint8ClampedArray(encoder.HEAPU8.slice(output, output + size).buffer);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const alpha = pixels[offset + 3];
      for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = alpha ? Math.min(255, Math.round(pixels[offset + channel] * 255 / alpha)) : 0;
    }
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not prepare the optimized preview.');
    context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
    const png = await canvas.convertToBlob({ type: 'image/png' });
    canvas.width = canvas.height = 1;
    return new Uint8Array(await png.arrayBuffer());
  } finally { for (const pointer of [input, output]) if (pointer) encoder._free(pointer); }
}
self.onmessage = async ({ data: { file } }) => {
  let encoder;
  try {
    if (file.size > previewLimit) throw new Error('Choose an optimized package or ZIP up to 128 MiB.');
    if (!self.OffscreenCanvas || !self.ImageData) throw new Error('Optimized preview needs a current Safari, Chrome, Edge, or Firefox browser.');
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) { report('Checking the optimized ZIP'); bytes = await readOptimizedZIP(bytes); }
    report('Decompressing the optimized package locally');
    encoder = await createEncoder();
    const riveData = unpack(encoder, bytes);
    const images = packageImages(riveData);
    if (encoder._astc_init() !== 0) throw new Error('The local texture decoder could not start.');
    const decoded = [];
    for (let i = 0; i < images.length; i++) { report(`Preparing optimized texture ${i + 1} of ${images.length}`); decoded.push(await decodeImage(encoder, images[i])); }
    const preview = replaceImages(riveData, images, decoded);
    if (!equalBytes(preview.subarray(0, 4), new TextEncoder().encode('RIVE'))) throw new Error('The package did not contain a valid Rive export.');
    self.postMessage({ type: 'complete', buffer: preview.buffer }, [preview.buffer]);
  } catch (error) { self.postMessage({ type: 'error', error: error?.message || 'This optimized package could not be opened.' }); }
  finally { encoder?._astc_release(); }
};
