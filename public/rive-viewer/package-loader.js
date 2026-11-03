/* Prepares optimized previews locally without changing the downloaded file. */
'use strict';
const optimizedPackageLoader = (() => {
  let pending = null;
  function cancel() {
    if (!pending) return;
    const { worker, timer, reject } = pending;
    pending = null;
    clearTimeout(timer);
    worker.terminate();
    reject(new Error('Optimized preview cancelled.'));
  }
  function open(file, progress) {
    cancel();
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(new URL('package-worker.js', document.baseURI), { type: 'module', name: 'Optimized Rive preview' }); }
      catch { reject(new Error('Optimized preview requires a current browser with WebAssembly support.')); return; }
      function finish(error, buffer) {
        if (pending?.worker !== worker) return;
        clearTimeout(pending.timer);
        pending = null;
        worker.terminate();
        if (error) reject(new Error(error));
        else resolve(buffer);
      }
      const timer = setTimeout(() => finish('Preparing the optimized preview took too long. Try a smaller file.'), 90000);
      pending = { worker, timer, reject };
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') progress(data.stage);
        else if (data.type === 'error') finish(data.error);
        else if (data.type === 'complete') finish(null, data.buffer);
      };
      worker.onerror = (event) => { event.preventDefault(); finish('The optimized preview could not run. Update your browser or try a smaller file.'); };
      worker.postMessage({ file });
    });
  }
  window.addEventListener('pagehide', cancel);
  return { open, cancel };
})();
