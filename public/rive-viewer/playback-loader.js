/* The parent owns the deadline, so a synchronous Wasm parse can be interrupted. */
'use strict';
const playbackSafety = (() => {
  function create() {
  let pending = null;
  let generation = 0;
  function cancel() {
    ++generation;
    if (!pending) return;
    pending.finish(new Error('Playback inspection cancelled.'));
  }
  async function inspect(buffer, { schema = false } = {}) {
    cancel();
    const ticket = generation;
    const { validatePlaybackBuffer, createAssetBudget } = await import('./playback-core.js');
    if (ticket !== generation) throw new Error('Playback inspection cancelled.');
    validatePlaybackBuffer(buffer);
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(new URL('playback-worker.js', document.baseURI), { name: 'Rive playback inspection' }); }
      catch { reject(new Error('Safe playback needs a browser with Web Worker support.')); return; }
      const finish = (error, checked, report) => {
        if (pending?.worker !== worker) return;
        clearTimeout(pending.timer);
        pending = null;
        worker.terminate();
        if (error) reject(error);
        else resolve({ buffer: checked, report, checkAsset: createAssetBudget() });
      };
      const timer = setTimeout(() => finish(new Error('Playback inspection reached its 20-second limit. Choose a smaller export.')), 20000);
      pending = { worker, timer, finish };
      worker.onmessage = ({ data }) => {
        if (data.type === 'complete') finish(null, data.buffer, data.report);
        else if (data.type === 'error') finish(new Error(data.error));
      };
      worker.onerror = (event) => { event.preventDefault(); finish(new Error('The playback inspector could not run. Update your browser or try another export.')); };
      worker.onmessageerror = () => finish(new Error('The playback inspector returned an unreadable result.'));
      try { worker.postMessage({ buffer, schema }, [buffer]); }
      catch { finish(new Error('The preview could not be sent to the playback inspector.')); }
    });
  }
  window.addEventListener('pagehide', cancel);
  return { inspect, cancel };
  }
  return { ...create(), create };
})();
