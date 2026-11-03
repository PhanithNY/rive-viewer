/* Import and inspect in a disposable worker before touching the UI runtime. */
importScripts('vendor/rive.js');
importScripts('inspector-core.js');

self.onmessage = async ({ data: { buffer, schema = false } }) => {
  let file, loader;
  try {
    const { validatePlaybackBuffer, createAssetBudget, inspectPlaybackFile } = await import('./playback-core.js');
    validatePlaybackBuffer(buffer);
    self.rive.RuntimeLoader.setWasmUrl(new URL('vendor/rive.wasm', self.location.href).href);
    self.rive.RuntimeLoader.setWasmFallbackUrl(null);
    const runtime = await self.rive.RuntimeLoader.awaitInstance();
    // This pinned runtime hook prevents authored scripts from executing during inspection.
    // The real viewer retains normal script behavior after the resource checks pass.
    runtime.startFileScripts = async (value) => value;
    const checkAsset = createAssetBudget();
    loader = new runtime.CustomFileAssetLoader({ loadContents: (asset, bytes) => {
      checkAsset(asset, bytes);
      return true; // Inspect headers only; never decode assets in this parse.
    } });
    file = await runtime.load(new Uint8Array(buffer), loader, false);
    if (!file) throw new Error('This Rive export could not be parsed.');
    inspectPlaybackFile(runtime, file);
    let report;
    if (schema) {
      try { report = self.RiveInspectorCore.fileReport(runtime, file); }
      catch { report = { version: 1, artboards: [], models: [], warnings: ['The runtime could not inspect this file’s complete property schema.'] }; }
    }
    self.postMessage({ type: 'complete', buffer, report }, [buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', error: error?.message || 'This export could not pass the playback safety checks.' });
  } finally { file?.delete(); loader?.delete(); }
};
