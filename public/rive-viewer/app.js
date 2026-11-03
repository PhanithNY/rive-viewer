/* Playback and optional texture optimization run locally; files are never uploaded. */
'use strict';
const $ = (id) => document.getElementById(id);
let player = null;
let artboards = [];
let tracks = [];
let generation = 0;
let readGeneration = 0;
let loadingTimer;
let resizeFrame;
let ready = false;
const missingAssets = new Set();
let currentFileInfo = null;
let currentFileReport = null;

function message(text = '', kind = 'info') {
  $('message').textContent = text;
  $('message').dataset.kind = kind;
  $('message').hidden = !text;
}
function option(label, value) {
  const item = document.createElement('option');
  item.textContent = label;
  item.value = value;
  return item;
}
function setBusy(busy) {
  if (busy) $('loading-label').textContent = 'Opening your animation…';
  $('loading').hidden = !busy;
  $('stage').setAttribute('aria-busy', String(busy));
}
function syncPlayback() {
  if (!ready || !player) return;
  const playing = player.isPlaying;
  $('play').textContent = playing ? 'Ⅱ' : '▶';
  $('play').setAttribute('aria-label', playing ? 'Pause animation' : 'Play animation');
  $('playback-status').textContent = tracks.length ? (playing ? 'PLAYING' : 'PAUSED') : 'STATIC ARTBOARD';
}
function resize() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (ready && player) player.resizeDrawingSurfaceToCanvas();
  });
}
function updateDimensions() {
  const bounds = player?.bounds;
  $('dimensions').textContent = bounds ? `${Math.round(bounds.maxX - bounds.minX)} × ${Math.round(bounds.maxY - bounds.minY)}` : 'LOCAL CANVAS';
}
function layout() {
  return new rive.Layout({ fit: rive.Fit[$('fit').value], alignment: rive.Alignment.Center });
}
function selectedTrack() { return tracks[Number($('track').value)]; }
function controlError(error) {
  message(`This control could not be applied. ${error?.message || 'Try restarting the animation.'}`, 'error');
}
function runControl(callback) {
  try { callback(); } catch (error) { controlError(error); }
}
function applyTrack() {
  if (!ready || !player) return;
  const track = selectedTrack();
  const params = { artboard: $('artboard').value, autoplay: !!track, autoBind: player.viewModelCount > 0 };
  if (track?.type === 'machine') params.stateMachine = track.name;
  // Timeline selection is retained deliberately for inspecting older Rive files.
  if (track?.type === 'animation') params.animations = track.name;
  propertyInspector.clear();
  propertyInspector.setFile(currentFileInfo, currentFileReport);
  player.reset(params);
  player.layout = layout();
  player.resizeDrawingSurfaceToCanvas();
  $('track-label').textContent = track?.name || 'Static artboard';
  $('play').disabled = !track;
  propertyInspector.attach(player, track);
  updateDimensions();
  syncPlayback();
}
function populateTracks() {
  const board = artboards.find((a) => a.name === $('artboard').value);
  tracks = [];
  $('track').replaceChildren();
  for (const [label, items, type] of [
    ['State machines', board?.stateMachines || [], 'machine'],
    ['Animations', board?.animations || [], 'animation'],
  ]) {
    if (!items.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const item of items) {
      const name = typeof item === 'string' ? item : item.name;
      group.append(option(name, String(tracks.length)));
      tracks.push({ type, name });
    }
    $('track').append(group);
  }
  if (!tracks.length) $('track').append(option('Static artboard', ''));
  $('track').disabled = !tracks.length;
  applyTrack();
}
function resetEmpty() {
  textureOptimizer.setFile(null);
  ready = false;
  propertyInspector.clear();
  player?.cleanup();
  player = null;
  artboards = [];
  tracks = [];
  $('canvas').hidden = true;
  $('empty').hidden = false;
  $('filename').textContent = 'No file open';
  $('filemeta').textContent = 'Choose a .riv file to try again.';
  $('playback-status').textContent = 'READY WHEN YOU ARE';
  $('artboard').replaceChildren(option('Open a file first', ''));
  $('track').replaceChildren(option('No animation selected', ''));
  for (const id of ['artboard', 'track', 'play', 'restart']) $(id).disabled = true;
  $('track-label').textContent = 'Nothing playing yet';
  $('dimensions').textContent = 'LOCAL CANVAS';
  currentFileInfo = currentFileReport = null;
}
async function loadFile(file) {
  if (!file) return;
  if (!/\.(riv|lzfse|zip)$/i.test(file.name)) return message('Choose a .riv export, .riv.astc.lzfse package, or optimized ZIP.', 'error');
  if (!file.size) return message('This file is empty. Please choose a valid .riv export.', 'error');
  if (file.size > 128 * 1024 * 1024) return message('Choose a .riv export up to 40 MiB or an optimized package up to 128 MiB.', 'error');
  const readTicket = ++readGeneration;
  clearTimeout(loadingTimer);
  optimizedPackageLoader.cancel();
  playbackSafety.cancel();
  textureOptimizer.cancel();
  let ticket;
  let replaced = false;
  message();
  setBusy(true);
  try {
    if (!window.rive) throw new Error('The bundled Rive engine is missing. Keep the vendor folder with this viewer.');
    const header = new TextDecoder().decode(await file.slice(0, 8).arrayBuffer());
    if (readTicket !== readGeneration) return;
    const optimized = header === 'RIVASTC1' || header.startsWith('PK') || /\.(lzfse|zip)$/i.test(file.name);
    if (!optimized && file.size > 40 * 1024 * 1024) throw new Error('Choose a .riv export up to 40 MiB.');
    const prepared = optimized
      ? await optimizedPackageLoader.open(file, (stage) => { if (readTicket === readGeneration) $('loading-label').textContent = stage + '…'; })
      : await file.arrayBuffer();
    if (readTicket !== readGeneration) return;
    $('loading-label').textContent = 'Checking playback resources…';
    const { buffer, checkAsset, report } = await playbackSafety.inspect(prepared, { schema: true });
    if (readTicket !== readGeneration) return;
    ticket = ++generation;
    clearTimeout(loadingTimer);
    ready = false;
    propertyInspector.clear();
    player?.cleanup();
    player = null;
    currentFileInfo = { name: file.name, bytes: file.size };
    currentFileReport = report;
    replaced = true;
    textureOptimizer.setFile(null);
    for (const id of ['artboard', 'track', 'play', 'restart']) $(id).disabled = true;
    missingAssets.clear();
    $('canvas').hidden = false;
    $('empty').hidden = true;
    $('filename').textContent = file.name;
    $('filemeta').textContent = `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(file.size / 1024)} KB · ${optimized ? 'Optimized package · decoded preview' : 'Local preview'}`;
    const fail = (detail) => {
      if (ticket !== generation || readTicket !== readGeneration) return;
      ++generation;
      clearTimeout(loadingTimer);
      setBusy(false);
      resetEmpty();
      message(detail || 'Could not open this Rive file. It may be damaged or require a newer runtime. Check that WebGL2 is enabled in your browser.', 'error');
    };
    loadingTimer = setTimeout(() => fail('Opening this file took too long. Try a different .riv file or reload the viewer.'), 20000);
    player = new rive.Rive({
      canvas: $('canvas'), buffer, autoplay: false, autoBind: false,
      layout: layout(), enableRiveAssetCDN: false,
      assetLoader: (asset, bytes) => {
        checkAsset(asset, bytes);
        if (!bytes.length) missingAssets.add(asset.name || 'Unnamed asset');
        return false;
      },
      onLoad: () => {
        if (ticket !== generation || readTicket !== readGeneration) return;
        try {
          clearTimeout(loadingTimer);
          artboards = player.contents.artboards || [];
          if (!artboards.length) return fail('This file has no artboards to preview.');
          $('artboard').replaceChildren(...artboards.map((board) => option(board.name, board.name)));
          $('artboard').value = player.activeArtboard || artboards[0].name;
          $('artboard').disabled = false;
          $('restart').disabled = false;
          ready = true;
          textureOptimizer.setFile(optimized ? null : file);
          populateTracks();
          setBusy(false);
          const notes = [];
          if (optimized) notes.push('Optimized package opened locally. Textures are decoded for browser playback; this preview does not measure compressed GPU-memory savings.');
          if (missingAssets.size) notes.push(`Some assets are not embedded: ${[...missingAssets].join(', ')}. Export with embedded fonts, images and audio for a complete offline preview.`);
          if (notes.length) message(notes.join(' '));
        } catch (error) { fail(`Could not prepare this file. ${error.message}`); }
      },
      onLoadError: () => fail(),
      onPlay: () => queueMicrotask(syncPlayback),
      onPause: () => queueMicrotask(syncPlayback),
      onStop: () => queueMicrotask(syncPlayback),
    });
  } catch (error) {
    if (readTicket !== readGeneration || (ticket !== undefined && ticket !== generation)) return;
    clearTimeout(loadingTimer);
    setBusy(false);
    if (replaced) resetEmpty();
    message(error.message || 'This file could not be read. Please try again.', 'error');
  }
}

if (window.rive) {
  // A file inspector intentionally supports timelines and legacy input exports.
  rive.Rive.suppressDeprecationWarnings = ['default-state-machine', 'animation-names', 'animations-param', 'state-machine-inputs'];
  rive.RuntimeLoader.setWasmUrl(new URL('vendor/rive.wasm', document.baseURI).href);
  rive.RuntimeLoader.setWasmFallbackUrl(null);
} else message('The bundled Rive engine could not be loaded. Keep the vendor folder with this viewer.', 'error');
for (const id of ['open', 'browse']) $(id).addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (event) => { loadFile(event.target.files[0]); event.target.value = ''; });
$('artboard').addEventListener('change', () => runControl(populateTracks));
$('track').addEventListener('change', () => runControl(applyTrack));
$('restart').addEventListener('click', () => runControl(applyTrack));
$('play').addEventListener('click', () => runControl(() => {
  if (!ready || !player) return;
  if (player.isPlaying) player.pause();
  else player.play();
  syncPlayback();
}));
$('fit').addEventListener('change', () => runControl(() => { if (ready && player) { player.layout = layout(); resize(); } }));
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    $('file-input').click();
  }
});
if (!navigator.platform.toLowerCase().includes('mac')) document.querySelector('kbd').textContent = 'Ctrl O';
let dragDepth = 0;
document.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragDepth++;
  $('drop-overlay').hidden = false;
});
document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
document.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const files = event.dataTransfer?.files;
  if (files?.length === 1) loadFile(files[0]);
  else if (files?.length > 1) message('Please drop one .riv file at a time.', 'error');
});
window.addEventListener('blur', () => { dragDepth = 0; $('drop-overlay').hidden = true; });
new ResizeObserver(resize).observe($('stage'));
// Match the two heading rows using their content, so they can also shrink again
// after wrapping changes when the inspector is resized or fonts finish loading.
const panelHeadings = [document.querySelector('.workspace-bar'), document.querySelector('.privacy-note')];
const panelGrid = document.querySelector('main');
const headingObserver = new ResizeObserver(() => {
  const naturalHeight = (heading) => {
    const style = getComputedStyle(heading);
    const content = Math.max(0, ...Array.from(heading.children, child => child.getBoundingClientRect().height));
    return content + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  };
  const height = `${Math.ceil(Math.max(84, ...panelHeadings.map(naturalHeight)))}px`;
  if (panelGrid.style.getPropertyValue('--panel-heading-height') !== height)
    panelGrid.style.setProperty('--panel-heading-height', height);
});
for (const heading of panelHeadings) for (const child of heading.children) headingObserver.observe(child);
// Keep both panels aligned even when file notices or the viewport change size.
new ResizeObserver(([entry]) => {
  const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
  $('inspector').style.height = `${height}px`;
}).observe(document.querySelector('.workspace'));
window.addEventListener('resize', resize);
$('canvas').addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  ++generation;
  clearTimeout(loadingTimer);
  setBusy(false);
  resetEmpty();
  message('The graphics context was lost. Reload the viewer and reopen your file.', 'error');
});
window.addEventListener('pagehide', () => {
  // Invalidate pending reads before cancelling workers or releasing the player.
  ++readGeneration;
  ++generation;
  clearTimeout(loadingTimer);
  cancelAnimationFrame(resizeFrame);
  optimizedPackageLoader.cancel();
  playbackSafety.cancel();
  resetEmpty();
  missingAssets.clear();
  setBusy(false);
  message();
  $('filemeta').textContent = 'A little space to bring your animations to life.';
  $('fit').value = 'Contain';
  $('file-input').value = '';
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', 'Play animation');
  dragDepth = 0;
  $('drop-overlay').hidden = true;
});
window.addEventListener('pageshow', (event) => {
  // A restored document can retain a released WebGL runtime. Start fresh.
  if (event.persisted) window.location.reload();
  else $('fit').value = 'Contain';
});
