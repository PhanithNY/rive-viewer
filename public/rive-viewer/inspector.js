/* File inspection UI. All reports and comparisons remain on this device. */
'use strict';
const propertyInspector = (() => {
  const core = RiveInspectorCore;
  const el = (id) => document.getElementById(id);
  const make = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };
  const option = (text, value) => { const item = make('option', '', text); item.value = value; return item; };
  let player, track, fileInfo, fileReport, selected, owned, models = [], nodes = [], records = new Map();
  let unsubscribers = [], initial = new Map(), pins = new Set(), events = [], listeners = [];
  let baselines = new WeakMap(), legacyInitial = null;
  let scope = 'live';
  const isLive = () => scope === 'live';
  let eventFrame = 0, treeFrame = 0, listTimer = 0, selection = 0, compareTicket = 0;
  let compareSafety;
  let playbackFrame = 0, playbackTimer = 0, latestStates = [], extraStates = 0;
  const error = (cause) => {
    el('inspector-notice').textContent = cause?.message || 'This property could not be updated.';
    el('inspector-notice').hidden = false;
  };
  const safe = (callback) => { try { callback(); } catch (cause) { error(cause); } };
  const valueText = (node) => node.type === 'trigger' ? 'Trigger' : node.type === 'list' ? `${node.length} items` : String(node.value ?? node.status ?? '');
  function unsubscribe() {
    unsubscribers.splice(0).forEach((off) => off());
    clearTimeout(listTimer);
    listTimer = 0;
    cancelAnimationFrame(treeFrame);
  }
  function resetPlayback() {
    cancelAnimationFrame(playbackFrame);
    clearTimeout(playbackTimer);
    playbackFrame = playbackTimer = 0;
    latestStates = []; extraStates = 0;
    el('now-playing').hidden = true;
    el('advanced-tools').hidden = true;
    el('now-properties').disabled = true;
    for (const id of ['now-artboard', 'now-machines', 'now-animations', 'now-model']) el(id).textContent = '—';
    el('now-status').textContent = 'Stopped';
    el('now-status').dataset.playing = 'false';
    el('now-states').textContent = 'No transitions reported yet';
  }
  function releaseSelection() {
    ++selection;
    unsubscribe();
    // The bound instance belongs to the player. Only release our browsing wrapper.
    owned?.decrementReferenceCount();
    owned = selected = null;
    records.clear();
  }
  function clear() {
    releaseSelection();
    listeners.splice(0).forEach((off) => off());
    cancelAnimationFrame(eventFrame);
    eventFrame = 0;
    cancelAnimationFrame(treeFrame);
    resetPlayback();
    ++compareTicket;
    compareSafety?.cancel();
    player = track = fileInfo = fileReport = null;
    models = []; nodes = []; initial.clear(); pins.clear(); events = [];
    baselines = new WeakMap(); legacyInitial = null;
    el('inputs').replaceChildren(make('p', 'hint', 'Open a file to inspect its properties.'));
    scope = 'live';
    el('model-select').replaceChildren(option('No file open', ''));
    el('model-count').textContent = '0';
    el('live-model').textContent = 'No file open';
    el('artboard-connection').textContent = 'Open a file to see its artboard connections.';
    el('preview-connection').hidden = true;
    el('artboard-connections').replaceChildren();
    el('artboard-connection-count').textContent = '0';
    el('artboard-map').hidden = true;
    updateScope();
    el('instance-select').replaceChildren(option('No instance selected', ''));
    for (const id of ['inspect-live', 'inspect-file', 'model-select', 'instance-select', 'property-search', 'reset-values', 'download-report', 'compare-open', 'use-instance']) el(id).disabled = true;
    el('property-search').value = '';
    el('property-count').textContent = '0 properties';
    el('binding-status').textContent = 'No file open';
    el('watch-list').replaceChildren(); el('watch-list').hidden = true;
    el('inspector-notice').hidden = true;
    el('compare-result').replaceChildren();
    el('compare-file').value = '';
    el('event-state').textContent = 'No transitions yet';
    renderEvents();
    document.body.classList.remove('file-loaded');
  }
  function addEvent(kind, data) {
    let detail;
    if (Array.isArray(data)) detail = data.map(String).join(', ');
    else if (data && typeof data === 'object') detail = String(data.name || data.type || 'Event');
    else detail = String(data ?? '');
    events.push({ time: new Date().toLocaleTimeString(), kind, detail: detail.slice(0, 1024) });
    if (events.length > 200) events.shift();
    if (kind === 'State') el('event-state').textContent = detail.slice(0, 512);
    if (!eventFrame) eventFrame = requestAnimationFrame(() => { eventFrame = 0; renderEvents(); });
  }
  function renderEvents() {
    const query = el('event-filter').value.trim().toLowerCase();
    const shown = events.filter(item => `${item.kind} ${item.detail}`.toLowerCase().includes(query));
    el('event-count').textContent = String(events.length);
    el('event-list').replaceChildren(...shown.slice().reverse().map(item => {
      const row = make('li', 'event-row');
      row.append(make('time', '', item.time), make('span', 'event-kind', item.kind), make('span', '', item.detail));
      return row;
    }));
    if (!shown.length) el('event-list').append(make('li', 'hint', events.length ? 'No matching events.' : 'Interact with the preview to see transitions and events.'));
  }
  function setFile(info, report) { fileInfo = info; fileReport = report; }
  function attach(nextPlayer, nextTrack) {
    releaseSelection();
    listeners.splice(0).forEach(off => off());
    resetPlayback();
    player = nextPlayer; track = nextTrack;
    if (!player) return clear();
    latestStates = []; extraStates = 0;
    document.body.classList.add('file-loaded');
    models = [];
    for (let i = 0; i < Math.min(player.viewModelCount, core.limits.models); i++) {
      const model = player.viewModelByIndex(i);
      if (model) models.push(model);
    }
    // The runtime enumerates definitions once by index. The live instance is
    // an inspection scope, never an extra definition or dropdown entry.
    el('model-select').replaceChildren(...models.map((model, i) => option(model.name || `View Model ${i + 1}`, String(i))));
    if (!models.length) el('model-select').append(option('No View Models in this file', ''));
    el('model-count').textContent = String(player.viewModelCount);
    el('model-select').disabled = !models.length;
    el('inspect-live').disabled = false;
    el('inspect-file').disabled = !models.length;
    scope = 'live';
    renderConnections();
    for (const [type, label] of [['statechange', 'State'], ['riveevent', 'Rive event'], ['play', 'Play'], ['pause', 'Pause'], ['stop', 'Stop'], ['loop', 'Loop']]) {
      const callback = (event) => {
        if (player !== nextPlayer) return;
        if (type === 'statechange') {
          const names = Array.isArray(event.data) ? event.data.filter(name => typeof name === 'string') : [];
          latestStates = names.slice(0, 16).map(name => name.slice(0, 256));
          extraStates = Math.max(0, names.length - latestStates.length);
        }
        addEvent(label, event.data);
        schedulePlayback();
      };
      player.on(type, callback);
      listeners.push(() => nextPlayer.off(type, callback));
    }
    // A bounded update rate also catches one-shot animations completing and
    // changes made by authored logic. Never advance or modify the animation here.
    const onAdvance = () => {
      if (player !== nextPlayer || playbackTimer || document.hidden) return;
      playbackTimer = setTimeout(() => { playbackTimer = 0; if (player === nextPlayer) schedulePlayback(); }, 200);
    };
    player.on('advance', onAdvance);
    listeners.push(() => nextPlayer.off('advance', onAdvance));
    for (const id of ['property-search', 'download-report', 'compare-open']) el(id).disabled = false;
    chooseModel();
    addEvent('Inspect', `${player.activeArtboard} · ${track?.name || 'Static artboard'}`);
  }
  function schedulePlayback() {
    if (playbackFrame) return;
    const current = player;
    playbackFrame = requestAnimationFrame(() => {
      playbackFrame = 0;
      if (current && current === player) renderPlayback();
    });
  }
  function renderPlayback() {
    if (!player) return;
    const names = (value) => Array.isArray(value) ? value.filter(name => typeof name === 'string').slice(0, 64).map(name => name.length > 256 ? name.slice(0, 256) + '…' : name) : [];
    const playingMachines = names(player.playingStateMachineNames), pausedMachines = names(player.pausedStateMachineNames);
    const playingAnimations = names(player.playingAnimationNames), pausedAnimations = names(player.pausedAnimationNames);
    const describe = (playing, paused) => [...playing, ...paused.map(name => `${name} (paused)`)].join(', ');
    const hasMachines = playingMachines.length + pausedMachines.length > 0;
    const live = liveInstance();
    const status = player.isPlaying ? 'Playing' : player.isPaused ? 'Paused' : track ? 'Stopped' : 'Static artboard';
    const text = (id, value) => { if (el(id).textContent !== value) el(id).textContent = value; };
    el('now-playing').hidden = false;
    el('advanced-tools').hidden = false;
    text('now-status', status);
    el('now-status').dataset.playing = String(!!player.isPlaying);
    text('now-artboard', player.activeArtboard || 'Unnamed artboard');
    text('now-machines', describe(playingMachines, pausedMachines) || 'None running');
    text('now-animations', describe(playingAnimations, pausedAnimations) || (hasMachines ? 'Inside state machine · names unavailable' : 'None running'));
    text('now-model', live ? live.viewModelName || 'Unnamed View Model' : 'No View Model bound');
    text('now-states', latestStates.length ? latestStates.join(', ') + (extraStates ? ` (+${extraStates} more)` : '') : 'No transitions reported yet');
    el('now-states-row').hidden = !hasMachines || !latestStates.length;
    el('now-visibility').hidden = !hasMachines;
    el('now-properties').disabled = !live && !(track?.type === 'machine' && player.stateMachineInputs(track.name)?.length);
  }
  const modelLabel = (name) => name === undefined ? 'Assignment unavailable' : name === null ? 'No View Model assigned' : name || 'Unnamed View Model';
  function liveInstance() {
    const instance = player?.viewModelInstance;
    if (!instance) return null;
    // The pinned runtime retains this getter's previous instance when reset()
    // switches to an unassigned artboard. It is not that artboard's live binding.
    const assigned = player.defaultViewModel();
    return assigned && assigned.name === instance.viewModelName ? instance : null;
  }
  function assignedModel(board) {
    if (Object.hasOwn(board, 'viewModel')) return board.viewModel;
    if (board.name === player.activeArtboard) {
      try { const model = player.defaultViewModel(); return model ? model.name : null; } catch { /* Keep unknown assignments distinct from unassigned ones. */ }
    }
    return undefined;
  }
  function renderConnections() {
    const boards = fileReport?.artboards?.length ? fileReport.artboards
      : player.contents?.artboards?.length ? player.contents.artboards : [{ name: player.activeArtboard }];
    el('artboard-connection-count').textContent = String(boards.length);
    el('artboard-map').hidden = false;
    el('artboard-connections').replaceChildren(...boards.map(board => {
      const row = make('li');
      const button = make('button', 'artboard-link');
      button.type = 'button';
      button.setAttribute('aria-label', `Preview artboard ${board.name}. Assigned View Model: ${modelLabel(assignedModel(board))}`);
      if (board.name === player.activeArtboard) button.setAttribute('aria-current', 'true');
      button.append(make('span', 'relationship-artboard', board.name), make('span', 'relationship-arrow', '→'), make('span', 'relationship-model', modelLabel(assignedModel(board))));
      button.addEventListener('click', () => {
        if (board.name === player?.activeArtboard) return;
        el('artboard').value = board.name;
        el('artboard').dispatchEvent(new Event('change', { bubbles: true }));
      });
      row.append(button);
      return row;
    }));
  }
  function updateConnection() {
    if (!player) return;
    const board = fileReport?.artboards?.find(board => board.name === player.activeArtboard) || { name: player.activeArtboard };
    el('artboard-connection').replaceChildren(make('strong', 'relationship-artboard', board.name), make('span', 'relationship-arrow', '→'), make('span', 'relationship-model', modelLabel(assignedModel(board))));
    const live = liveInstance();
    el('preview-connection').textContent = live ? `Live preview → ${live.viewModelName || 'Unnamed View Model'} instance` : 'Live preview → No View Model bound';
    el('preview-connection').hidden = false;
  }
  function updateScope() {
    updateConnection();
    if (player) renderPlayback();
    el('inspect-live').setAttribute('aria-pressed', String(isLive()));
    el('inspect-file').setAttribute('aria-pressed', String(!isLive()));
    el('file-model-field').hidden = isLive();
    el('live-model').hidden = !isLive();
    if (player) {
      const live = liveInstance();
      el('live-model').textContent = live ? `Bound View Model · ${live.viewModelName || 'Unnamed View Model'}` : 'No View Model bound';
    }
  }
  function chooseModel() {
    releaseSelection(); initial.clear(); pins.clear();
    updateScope();
    const model = models[Number(el('model-select').value)];
    if (isLive()) {
      el('instance-select').replaceChildren(option(liveInstance() ? 'Live preview instance' : 'No instance bound', 'bound'));
      el('instance-select').disabled = true;
    } else {
      const names = model?.instanceNames || [];
      el('instance-select').replaceChildren(option('Definition only', 'schema'), ...names.slice(0, core.limits.instances).map((name, i) => option(name || `Instance ${i + 1}`, String(i))));
      el('instance-select').value = names.length ? '0' : 'schema';
      el('instance-select').disabled = !names.length;
    }
    chooseInstance();
  }
  function chooseInstance() {
    releaseSelection(); initial.clear(); pins.clear();
    const bound = isLive();
    const model = models[Number(el('model-select').value)];
    if (bound) selected = liveInstance();
    else if (el('instance-select').value !== 'schema') {
      selected = owned = model?.instanceByIndex(Number(el('instance-select').value));
      owned?.incrementReferenceCount();
    }
    el('binding-status').textContent = bound ? (selected ? 'LIVE · Drives the preview' : 'No View Model bound') : 'BROWSING · Preview binding unchanged';
    el('use-instance').hidden = bound;
    el('use-instance').disabled = !selected || model?.name !== player.defaultViewModel()?.name;
    captureSelection(true);
  }
  function captureSelection(baseline = false) {
    unsubscribe(); records = new Map();
    const state = core.budget();
    nodes = selected ? core.capture(selected, { state, bind: (node, property) => {
      records.set(core.key(node.path), { node, property });
    } }) : [];
    if (!selected && !isLive()) {
      const model = models[Number(el('model-select').value)];
      nodes = (model?.properties || []).slice(0, core.limits.nodes).map(property => ({ ...property, path: [property.name], status: 'Definition only. Select a saved instance to inspect its value.' }));
    }
    if (isLive() && track?.type === 'machine') {
      const inputs = (player.stateMachineInputs(track.name) || []).slice(0, 1024).map(input => {
        const type = input.type === rive.StateMachineInputType.Boolean ? 'boolean' : input.type === rive.StateMachineInputType.Trigger ? 'trigger' : 'number';
        const node = { name: input.name, type, path: ['$inputs', input.name] };
        if (type !== 'trigger') node.value = input.value;
        records.set(core.key(node.path), { node, property: input, legacy: true });
        return node;
      });
      if (inputs.length) nodes = [{ name: 'State machine inputs', type: 'viewModel', path: ['$inputs'], children: inputs }, ...nodes];
    }
    const warnings = [...state.warnings];
    if (player.viewModelCount > core.limits.models) warnings.push('Some View Models are omitted from the model selector.');
    const activeModel = models[Number(el('model-select').value)];
    if (!isLive() && activeModel?.instanceCount > core.limits.instances) warnings.push('Showing the first 32 saved instances.');
    if (fileReport?.warnings?.length) warnings.push(...fileReport.warnings);
    el('inspector-notice').textContent = warnings.join(' ');
    el('inspector-notice').hidden = !warnings.length;
    for (const [id, record] of records) {
      const { node, property, legacy } = record;
      if (baseline && node.type !== 'list' && node.type !== 'trigger' && !node.status && !node.path.some(segment => typeof segment === 'number')) initial.set(id, node.value);
      if (typeof property.on === 'function' && !legacy) {
        const ticket = selection;
        const callback = () => {
          if (ticket !== selection) return;
          if (node.type === 'list') {
            // List structure changes rebuild once after the runtime finishes dispatching callbacks.
            if (!listTimer) listTimer = setTimeout(() => { listTimer = 0; safe(() => captureSelection()); }, 100);
          } else syncRecord(record);
        };
        property.on(callback);
        unsubscribers.push(() => property.off(callback));
      }
    }
    // Legacy state-machine inputs have no change subscription API.
    if ([...records.values()].some(record => record.legacy)) {
      const timer = setInterval(() => { if (!document.hidden) for (const record of records.values()) if (record.legacy) safe(() => syncRecord(record)); }, 200);
      unsubscribers.push(() => clearInterval(timer));
    }
    if (baseline) {
      const saved = selected ? baselines.get(selected) : legacyInitial;
      if (saved) initial = new Map(saved);
      else if (selected) baselines.set(selected, new Map(initial));
      else if (isLive()) legacyInitial = new Map(initial);
    }
    el('reset-values').disabled = !initial.size;
    renderTree();
  }
  function syncRecord(record) {
    const { node, property } = record;
    if (node.type !== 'trigger') node.value = node.type === 'color' ? core.colorHex(property.value) : property.value;
    record.sync?.();
    if (pins.has(core.key(node.path))) renderWatch();
  }
  function write(record, value) {
    const { node, property } = record;
    if (node.type === 'trigger') record.legacy ? property.fire() : property.trigger();
    else property.value = node.type === 'color' ? core.colorValue(value) : value;
    syncRecord(record);
  }
  function row(node, readOnly = false) {
    const record = records.get(core.key(node.path));
    const item = make('div', 'property-row');
    const heading = make('div', 'property-heading');
    const name = make('span', 'property-name', node.name);
    name.title = node.path.join(' / ');
    heading.append(name, make('span', `type-badge type-${node.type}`, node.type === 'enumType' ? 'enum' : node.type));
    item.append(heading);
    const controls = make('div', 'property-controls');
    let control, alpha;
    const editable = record && !node.status && !readOnly;
    if (record && node.type === 'trigger') {
      control = make('button', 'property-trigger', 'Fire ↗');
      control.type = 'button'; control.disabled = !editable;
      control.addEventListener('click', () => safe(() => { write(record); addEvent('Trigger', node.path.join(' / ')); }));
    } else if (record && node.type === 'enumType') {
      control = make('select');
      control.append(...node.options.map(value => option(value, value)));
      control.disabled = !editable;
      control.addEventListener('change', () => safe(() => write(record, control.value)));
    } else if (record && ['string', 'number', 'boolean', 'color'].includes(node.type)) {
      control = make('input'); control.type = node.type === 'boolean' ? 'checkbox' : node.type === 'number' ? 'number' : node.type === 'color' ? 'color' : 'text';
      control.disabled = !editable;
      if (node.type === 'number') control.step = 'any';
      if (node.type === 'string') control.maxLength = core.limits.text;
      control.addEventListener('input', () => safe(() => {
        let value = node.type === 'boolean' ? control.checked : node.type === 'number' ? control.valueAsNumber : node.type === 'color' ? control.value + node.value.slice(7) : control.value;
        if (node.type === 'number' && !Number.isFinite(value)) return;
        write(record, value);
      }));
      if (node.type === 'color') {
        alpha = make('input'); alpha.type = 'number'; alpha.min = '0'; alpha.max = '100'; alpha.step = '1'; alpha.disabled = !editable;
        alpha.setAttribute('aria-label', `${node.path.join(' / ')} opacity percent`);
        alpha.addEventListener('input', () => safe(() => {
          if (!Number.isFinite(alpha.valueAsNumber) || alpha.valueAsNumber < 0 || alpha.valueAsNumber > 100) return;
          write(record, control.value + Math.round(alpha.valueAsNumber * 2.55).toString(16).padStart(2, '0'));
        }));
      }
    }
    if (control) {
      control.setAttribute('aria-label', node.path.join(' / '));
      control.addEventListener('blur', () => record.sync?.());
      alpha?.addEventListener('blur', () => record.sync?.());
      controls.append(control);
      if (alpha) controls.append(alpha, make('span', 'opacity-unit', '%'));
      record.sync = () => {
        if (node.type === 'trigger') return;
        if (control.type === 'checkbox') control.checked = !!node.value;
        else if (document.activeElement !== control) control.value = node.type === 'color' ? node.value.slice(0, 7) : node.value ?? '';
        if (alpha && document.activeElement !== alpha) alpha.value = String(Math.round(parseInt(node.value.slice(7), 16) / 255 * 100));
        if (node.type === 'color') controls.querySelector('.color-value').textContent = node.value;
      };
      if (node.type === 'color') controls.append(make('span', 'color-value', node.value));
      record.sync();
    }
    if (record && !['list', 'viewModel'].includes(node.type)) {
      const pin = make('button', 'pin-property', pins.has(core.key(node.path)) ? '★' : '☆');
      pin.type = 'button'; pin.setAttribute('aria-label', `${pins.has(core.key(node.path)) ? 'Unpin' : 'Pin'} ${node.path.join(' / ')}`);
      pin.setAttribute('aria-pressed', String(pins.has(core.key(node.path))));
      pin.addEventListener('click', () => {
        const id = core.key(node.path);
        if (pins.has(id)) pins.delete(id); else if (pins.size < 12) pins.add(id); else return error(new Error('Pin up to 12 properties at a time.'));
        renderTree();
      });
      controls.append(pin);
    }
    if (controls.childElementCount) item.append(controls);
    if (node.status) item.append(make('p', 'property-note', node.status));
    if (readOnly && control) item.append(make('span', 'property-note', 'List item · read only'));
    return item;
  }
  function renderTree() {
    const query = el('property-search').value.trim().toLowerCase();
    let shown = 0, total = 0;
    const previous = new Map(Array.from(el('inputs').querySelectorAll('details')).map(item => [item.dataset.path, item.open]));
    const matches = (node) => `${node.path.join(' / ')} ${node.type} ${(node.options || []).join(' ')}`.toLowerCase().includes(query);
    function branch(list, inherited = false, readOnly = false) {
      const fragment = document.createDocumentFragment();
      for (const node of list) {
        const ownMatch = inherited || !query || matches(node);
        if (node.children) {
          const children = branch(node.children, ownMatch, readOnly || node.type === 'list');
          if (ownMatch || children.childNodes.length) {
            const group = make('details', 'property-group');
            const id = core.key(node.path); group.dataset.path = id;
            group.open = query ? true : previous.has(id) ? previous.get(id) : node.path.length <= 1;
            const summary = make('summary');
            summary.append(make('span', 'property-name', node.name), make('span', 'type-badge', node.type === 'list' ? `list · ${node.length}` : 'view model'));
            group.append(summary, children);
            if (node.status) group.append(make('p', 'property-note', node.status));
            if (!node.children.length) group.append(make('p', 'property-note', node.type === 'list' ? 'This list is empty.' : 'No properties in this instance.'));
            fragment.append(group);
          }
        } else {
          total++;
          if (ownMatch) { shown++; fragment.append(row(node, readOnly)); }
        }
      }
      return fragment;
    }
    const content = branch(nodes);
    el('inputs').replaceChildren(content);
    if (!el('inputs').childElementCount) el('inputs').append(make('p', 'hint', query ? 'No properties match your search.' : 'No properties exposed here. Choose another View Model or state machine.'));
    el('property-count').textContent = query ? `${shown} of ${total} properties` : `${total} ${total === 1 ? 'property' : 'properties'}`;
    renderWatch();
  }
  function renderWatch() {
    const list = [];
    for (const id of pins) {
      const node = records.get(id)?.node;
      if (node) {
        const item = make('div', 'watch-item'); item.title = node.path.join(' / ');
        item.append(make('span', '', node.name), make('strong', '', valueText(node)));
        list.push(item);
      }
    }
    el('watch-list').replaceChildren(...list); el('watch-list').hidden = !list.length;
  }
  function downloadReport() {
    if (!fileInfo) return;
    const current = JSON.parse(JSON.stringify(nodes));
    const report = { file: fileInfo, runtime: 'Rive WebGL2 2.49.0',
      scope: 'Exported runtime properties; not the editor scene hierarchy. Values change only in memory.',
      exportedFile: fileReport, inspected: { artboard: player.activeArtboard, track: track?.name || null,
        scope, model: isLive() ? selected?.viewModelName || null : el('model-select').selectedOptions[0]?.textContent,
        instance: el('instance-select').selectedOptions[0]?.textContent,
        currentProperties: current, initialValues: Array.from(initial, ([path, value]) => ({ path: JSON.parse(path), value })) } };
    const markdown = el('report-format').value === 'markdown';
    let content = JSON.stringify(report, null, 2);
    if (markdown) {
      const escape = value => String(value).replace(/[\\`*_{}\[\]<>|]/g, '\\$&').replace(/[\r\n]/g, ' ');
      const lines = [`# Rive handoff: ${escape(fileInfo.name)}`, '', report.scope, '', `Runtime: ${report.runtime}`, '', '## Exported file', ''];
      for (const board of fileReport?.artboards || []) {
        lines.push(`### Artboard: ${escape(board.name)}`, '');
        lines.push(`Assigned View Model: ${escape(modelLabel(board.viewModel))}`, '');
        for (const machine of board.machines) {
          lines.push(`- State machine: ${escape(machine.name)}`);
          for (const input of machine.inputs) lines.push(`  - ${escape(input.name)} (${escape(input.type)})`);
        }
        for (const name of board.animations) lines.push(`- Animation: ${escape(name)}`);
        lines.push('');
      }
      for (const model of fileReport?.models || []) {
        lines.push(`### View Model: ${escape(model.name)}`, '');
        for (const property of model.properties) lines.push(`- ${escape(property.name)} (${escape(property.type)})`);
        for (const instance of model.instances) {
          lines.push('', `Saved instance: ${escape(instance.name)}`, '');
          core.walk(instance.properties, node => lines.push(`- ${escape(node.path.join(' / '))} (${escape(node.type)}): ${escape(valueText(node))}${node.options ? ` · Choices: ${node.options.map(escape).join(', ')}` : ''}`));
        }
        lines.push('');
      }
      if (fileReport?.warnings?.length) lines.push('## Inspection warnings', '', ...fileReport.warnings.map(warning => `- ${escape(warning)}`), '');
      lines.push('## Inspected current values', '');
      core.walk(current, node => { lines.push(`- ${escape(node.path.join(' / '))} (${node.type}): ${escape(valueText(node))}`); });
      content = lines.join('\n');
    }
    const url = URL.createObjectURL(new Blob([content], { type: markdown ? 'text/markdown' : 'application/json' }));
    const link = make('a'); link.href = url;
    link.download = `${fileInfo.name.replace(/\.[^.]+$/, '')}-handoff.${markdown ? 'md' : 'json'}`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function compareFile(file) {
    if (!file || !fileReport) return;
    const ticket = ++compareTicket;
    compareSafety ||= playbackSafety.create(); compareSafety.cancel();
    el('compare-result').replaceChildren(make('p', 'hint', 'Inspecting the previous export locally…'));
    try {
      if (!/\.riv$/i.test(file.name) || !file.size || file.size > 40 * 1024 * 1024) throw new Error('Choose a previous .riv export up to 40 MiB.');
      const buffer = await file.arrayBuffer();
      if (ticket !== compareTicket) return;
      const { report } = await compareSafety.inspect(buffer, { schema: true });
      if (ticket !== compareTicket) return;
      if (!report || report.warnings.length || fileReport.warnings.length) throw new Error('One of these inspections is incomplete. A reliable complete comparison is unavailable; check the handoff report warnings.');
      const changes = core.compare(report, fileReport);
      const heading = make('p', 'comparison-heading', `${file.name} → ${fileInfo.name}`);
      const summary = make('p', 'hint', changes.length ? `${changes.length} contract changes. Renames appear as a removal and an addition. Initial value changes and list contents are not compared.` : 'No changes to the inspected contract. Initial values and list contents are not compared.');
      const list = make('ul', 'comparison-list');
      for (const change of changes.slice(0, 300)) {
        const item = make('li', `comparison-${change.kind}`);
        item.append(make('strong', '', change.kind), make('span', '', change.path.join(' / ')), make('small', '', [change.before, change.after].filter(Boolean).join(' → ')));
        list.append(item);
      }
      el('compare-result').replaceChildren(heading, summary, list);
      if (changes.length > 300) el('compare-result').append(make('p', 'hint', 'Showing the first 300 changes.'));
    } catch (cause) {
      if (ticket === compareTicket) el('compare-result').replaceChildren(make('p', 'hint', cause.message || 'This comparison could not be completed.'));
    }
  }
  el('model-select').addEventListener('change', () => safe(chooseModel));
  el('now-properties').addEventListener('click', () => safe(() => {
    if (!player) return;
    if (!isLive()) { scope = 'live'; chooseModel(); }
    el('property-search').scrollIntoView({ block: 'start', behavior: 'auto' });
    el('property-search').focus({ preventScroll: true });
  }));
  el('inspect-live').addEventListener('click', () => safe(() => { if (!isLive()) { scope = 'live'; chooseModel(); } }));
  el('inspect-file').addEventListener('click', () => safe(() => { if (isLive()) { scope = 'file'; chooseModel(); } }));
  el('instance-select').addEventListener('change', () => safe(chooseInstance));
  el('property-search').addEventListener('input', renderTree);
  el('reset-values').addEventListener('click', () => safe(() => {
    for (const [id, value] of initial) { const record = records.get(id); if (record && !record.node.status) write(record, value); }
    addEvent('Reset', 'Restored initial property values. State machine history is unchanged.');
  }));
  el('use-instance').addEventListener('click', () => safe(() => {
    if (!selected || el('use-instance').disabled) return;
    player.bindViewModelInstance(selected);
    // The player now owns a reference. Release the browsing reference after switching.
    chooseModelBound();
  }));
  function chooseModelBound() { scope = 'live'; chooseModel(); }
  el('download-report').addEventListener('click', () => safe(downloadReport));
  el('compare-open').addEventListener('click', () => el('compare-file').click());
  el('compare-file').addEventListener('change', event => { compareFile(event.target.files[0]); event.target.value = ''; });
  el('event-filter').addEventListener('input', renderEvents);
  el('clear-events').addEventListener('click', () => { events = []; renderEvents(); });
  // Keyboard resizing complements the native pointer resize handle.
  el('inspector-width').addEventListener('input', event => { el('inspector').style.width = `${event.target.value}px`; });
  return { attach, clear, setFile, addEvent };
})();
