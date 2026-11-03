import createEncoder from './vendor/optimizer/encoder.js';
import { limits, parseRive, createKTX2, replaceImages, join, sha256, hex, equalBytes, makeZIP } from './optimizer-core.js';

const report = (stage) => self.postMessage({ type: 'progress', stage });
const allocate = (encoder, size) => {
  const pointer = encoder._malloc(size);
  if (!pointer) throw new Error('There is not enough browser memory for this file. Try fewer or smaller images.');
  return pointer;
};
function encodeMip(encoder, pixels, width, height) {
  const size = Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
  let input = 0, output = 0;
  try {
    input = allocate(encoder, pixels.length);
    output = allocate(encoder, size);
    encoder.HEAPU8.set(pixels, input);
    if (encoder._encode_astc(input, width, height, output, size) !== size) throw new Error('This texture could not be encoded. Try re-exporting the Rive file.');
    return encoder.HEAPU8.slice(output, output + size);
  } finally { if (input) encoder._free(input); if (output) encoder._free(output); }
}
function compress(encoder, data) {
  const capacity = data.length + 65536;
  let input = 0, output = 0, decoded = 0;
  try {
    input = allocate(encoder, data.length);
    output = allocate(encoder, capacity);
    encoder.HEAPU8.set(data, input);
    const size = encoder._compress_lzfse(input, data.length, output, capacity);
    if (!size) throw new Error('Package compression failed. Try a smaller file.');
    decoded = allocate(encoder, data.length);
    if (encoder._decompress_lzfse(output, size, decoded, data.length) !== data.length || !equalBytes(encoder.HEAPU8.subarray(decoded, decoded + data.length), data)) throw new Error('The compressed package could not be verified.');
    return encoder.HEAPU8.slice(output, output + size);
  } finally { for (const pointer of [input, output, decoded]) if (pointer) encoder._free(pointer); }
}
async function run(file) {
  if (!self.OffscreenCanvas || !self.createImageBitmap || !self.crypto?.subtle) throw new Error('Local optimization needs a current version of Safari, Chrome, Edge, or Firefox.');
  if (file.size > limits.bytes) throw new Error('Optimization supports files up to 40 MiB.');
  report('Checking embedded WebP images');
  const data = new Uint8Array(await file.arrayBuffer());
  const images = parseRive(data);
  report('Loading the local texture encoder');
  const encoder = await createEncoder();
  if (encoder._astc_init() !== 0) throw new Error('The texture encoder could not start. Try a smaller file or another browser.');
  const textures = [];
  let rgbaBytes = 0, astcBytes = 0;
  try {
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      let bitmap;
      try {
        bitmap = await createImageBitmap(new Blob([data.slice(image.content, image.end)], { type: 'image/webp' }));
        if (bitmap.width !== image.dimensions[0] || bitmap.height !== image.dimensions[1]) throw new Error('Decoded WebP dimensions did not match the export.');
        let [width, height] = image.dimensions;
        const levels = [];
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
        if (!context) throw new Error('This browser could not prepare the image textures.');
        while (true) {
          report(`Encoding image ${i + 1} of ${images.length} · ${width} × ${height}`);
          canvas.width = width;
          canvas.height = height;
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = 'high';
          context.drawImage(bitmap, 0, 0, width, height);
          const pixels = context.getImageData(0, 0, width, height).data;
          for (let offset = 0; offset < pixels.length; offset += 4) {
            const alpha = pixels[offset + 3];
            for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = Math.round(pixels[offset + channel] * alpha / 255);
          }
          const blocks = encodeMip(encoder, pixels, width, height);
          levels.push({ width, height, blocks });
          rgbaBytes += pixels.length;
          astcBytes += blocks.length;
          if (width === 1 && height === 1) break;
          width = Math.max(1, Math.floor(width / 2));
          height = Math.max(1, Math.floor(height / 2));
        }
        textures.push(createKTX2(levels));
        canvas.width = canvas.height = 1;
      } finally { bitmap?.close(); }
    }
    report('Verifying Rive data and compressing the package');
    const optimized = replaceImages(data, images, textures);
    if (optimized.length > limits.packageBytes) throw new Error('The optimized data exceeds the 128 MiB package limit.');
    const sourceHash = await sha256(data);
    const packageData = join([new TextEncoder().encode('RIVASTC1'), sourceHash, compress(encoder, optimized)]);
    const manifest = {
      source_sha256: hex(sourceHash), package_sha256: hex(await sha256(packageData)),
      recipe: 'browser-astc-4x4-v1', encoder: 'astcenc 5.4.0, 4x4, medium, linear, premultiplied RGBA',
      mip_generator: 'Browser Canvas2D high-quality sRGB resampling',
      source_bytes: data.length, optimized_riv_bytes: optimized.length, packaged_bytes: packageData.length,
      images: images.length, dimensions: images.map((image) => image.dimensions),
      rgba_mip_bytes: rgbaBytes, astc_mip_bytes: astcBytes,
    };
    const readme = 'Rive texture optimization — processed locally in your browser\n\n'
      + 'optimized.riv.astc.lzfse is a custom package, not an ordinary .riv export.\n'
      + 'Keep your original export as a fallback. ASTC is lossy; check visual quality.\n'
      + 'Validate the 8-byte RIVASTC1 signature and 32-byte original SHA-256.\n'
      + 'LZFSE-decompress bytes 40 onward. Use a Rive runtime and renderer with\n'
      + 'embedded KTX2/ASTC support on the target device. Ordinary .riv loaders\n'
      + 'cannot open the packaged bytes directly.\n'
      + 'The browser uses medium encoding quality and browser image resampling.\n'
      + 'Output can differ from the Mac tool. Texture memory estimates include\n'
      + 'mipmaps, not whole-app RAM. The package can be larger than the source.\n';
    const encodeText = (value) => new TextEncoder().encode(value);
    const zip = makeZIP([
      ['optimized.riv.astc.lzfse', packageData],
      ['optimized.riv.manifest.json', encodeText(JSON.stringify(manifest, null, 2) + '\n')],
      ['README.txt', encodeText(readme)],
    ]);
    if (zip.length > limits.packageBytes) throw new Error('The optimized ZIP exceeds the 128 MiB package limit.');
    self.postMessage({ type: 'complete', manifest, zip: zip.buffer }, [zip.buffer]);
  } finally { encoder._astc_release(); }
}
self.onmessage = async ({ data }) => {
  try { await run(data.file); }
  catch (error) {
    const detail = /memory|allocation/i.test(error?.message || '') ? 'There is not enough browser memory for this export. Try fewer or smaller images.' : error?.message || 'The file could not be optimized. Try re-exporting it from Rive.';
    self.postMessage({ type: 'error', error: detail });
  }
};
