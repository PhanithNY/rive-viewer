/* Optimize runs in a disposable browser worker. Files never leave this device. */
'use strict';
const textureOptimizer = (() => {
  const button = document.getElementById('optimize');
  const download = document.getElementById('optimized-download');
  const status = document.getElementById('optimization-status');
  const bytes = (n) => n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(2)} MiB`;
  let file = null, worker = null, downloadURL = null, timer;
  function message(text, error = false) {
    status.textContent = text;
    status.dataset.error = String(error);
    status.hidden = !text;
  }
  function stop() {
    clearTimeout(timer);
    worker?.terminate();
    worker = null;
    button.disabled = !file;
    button.textContent = 'GPU Optimize ↗';
  }
  function setFile(next) {
    stop();
    file = next;
    button.hidden = false;
    button.disabled = !file;
    download.hidden = true;
    download.removeAttribute('href');
    if (downloadURL) URL.revokeObjectURL(downloadURL);
    downloadURL = null;
    message('');
  }
  function fail(text) { stop(); message(text, true); }
  button.addEventListener('click', () => {
    if (worker) { stop(); message('Optimization cancelled. Your original file is unchanged.'); return; }
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) return message('Optimization supports files up to 40 MiB. Export fewer or smaller images and try again.', true);
    if (!window.Worker || !window.WebAssembly) return message('Local optimization requires a current browser with WebAssembly support.', true);
    message('Starting local optimization. Your file stays on this device.');
    button.textContent = 'Cancel';
    try {
      worker = new Worker(new URL('optimizer-worker.js', document.baseURI), { type: 'module', name: 'Rive texture optimizer' });
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') { message(`${data.stage}…`); return; }
        if (data.type === 'error') { fail(data.error); return; }
        if (data.type !== 'complete') return;
        stop();
        const r = data.manifest;
        const reduction = (1 - r.astc_mip_bytes / r.rgba_mip_bytes) * 100;
        const change = reduction >= 0 ? `${reduction.toFixed(1)}% less` : `${Math.abs(reduction).toFixed(1)}% more`;
        message(`Done locally. Texture memory: ${bytes(r.rgba_mip_bytes)} → ${bytes(r.astc_mip_bytes)} (${change}). Package: ${bytes(r.packaged_bytes)}; original: ${bytes(r.source_bytes)}. Estimates include mipmaps, not whole-app RAM. ASTC is lossy; check quality in your app.`);
        downloadURL = URL.createObjectURL(new Blob([data.zip], { type: 'application/zip' }));
        download.href = downloadURL;
        download.hidden = false;
        button.hidden = true;
        download.focus();
      };
      worker.onerror = (event) => { event.preventDefault(); fail('The local encoder could not run. Try updating your browser or using a smaller file.'); };
      timer = setTimeout(() => fail('Optimization reached the ten-minute limit. Try fewer or smaller images.'), 10 * 60 * 1000);
      worker.postMessage({ file });
    } catch { fail('The local encoder could not start. Try a current Safari, Chrome, Edge, or Firefox browser.'); }
  });
  window.addEventListener('pagehide', () => { stop(); });
  return { setFile, cancel: stop };
})();
