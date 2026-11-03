/* Shared, bounded snapshots for the inspector, local reports and version comparison. */
'use strict';
globalThis.RiveInspectorCore = (() => {
  const limits = Object.freeze({ nodes: 2048, depth: 12, listItems: 64, models: 128, instances: 32, text: 16384 });
  const methods = { string: 'string', number: 'number', boolean: 'boolean', color: 'color', enumType: 'enum', trigger: 'trigger', list: 'list', viewModel: 'viewModel' };
  const properties = (instance) => instance.properties ?? instance.getProperties();
  const key = (path) => JSON.stringify(path);
  function budget(max = limits.nodes) { return { left: max, warnings: new Set() }; }
  function colorHex(value) {
    const hex = (Number(value) >>> 0).toString(16).padStart(8, '0');
    return `#${hex.slice(2)}${hex.slice(0, 2)}`; // Rive ARGB → CSS RGBA
  }
  function colorValue(hex) {
    if (!/^#[\da-f]{8}$/i.test(hex)) throw new Error('Use a color in #RRGGBBAA format.');
    return parseInt(hex.slice(7) + hex.slice(1, 7), 16) >>> 0;
  }
  function capture(instance, { state = budget(), path = [], depth = 0, ancestors = [], bind = () => {} } = {}) {
    if (!instance) return [];
    if (depth > limits.depth || ancestors.includes(instance)) {
      state.warnings.add('Some nested content is omitted: maximum depth or a repeated reference was reached.');
      return [{ name: 'More nested content', path, type: 'notice', status: 'Depth or repeated-reference limit reached.' }];
    }
    const nodes = [];
    for (const { name, type } of properties(instance)) {
      if (state.left-- <= 0) { state.warnings.add('Property limit reached. This inspection is partial.'); break; }
      const node = { name, type, path: [...path, name] };
      nodes.push(node);
      try {
        if (!methods[type]) { node.status = 'This property type is visible but cannot be edited in this viewer.'; continue; }
        if (name.includes('/')) { node.status = 'The runtime cannot unambiguously address this name because it contains a slash.'; state.warnings.add('Some property values cannot be addressed by the runtime.'); continue; }
        const value = instance[methods[type]](name);
        if (!value) { node.status = 'No value is available for this property in this instance.'; state.warnings.add('Some property values are unavailable.'); continue; }
        if (type === 'viewModel') {
          node.children = capture(value, { state, path: node.path, depth: depth + 1, ancestors: [...ancestors, instance], bind });
        } else if (type === 'list') {
          // The public wrapper exposes length; the native worker API exposes size.
          const size = value.length ?? value.size;
          if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid list length.');
          node.length = size;
          node.children = [];
          for (let i = 0; i < Math.min(size, limits.listItems) && state.left > 0; i++) {
            state.left--;
            const itemPath = [...node.path, i];
            node.children.push({ name: `Item ${i + 1}`, type: 'viewModel', path: itemPath,
              children: capture(value.instanceAt(i), { state, path: itemPath, depth: depth + 1, ancestors: [...ancestors, instance], bind }) });
          }
          if (node.children.length < size) {
            node.status = `Showing ${node.children.length} of ${size} items.`;
            state.warnings.add('Some list items are omitted. This inspection is partial.');
          }
          bind(node, value);
        } else {
          if (type !== 'trigger') {
            node.value = type === 'color' ? colorHex(value.value) : value.value;
            if (typeof node.value === 'string' && node.value.length > limits.text) {
              node.value = node.value.slice(0, limits.text);
              node.status = 'Long value truncated; editing is disabled.';
              state.warnings.add('Some long values are truncated.');
            }
          }
          if (type === 'enumType') {
            node.options = Array.from(value.values).slice(0, 512);
            if (value.values.length > 512) { node.status = 'Enum choices truncated; editing is disabled.'; state.warnings.add(node.status); }
          }
          bind(node, value);
        }
      } catch { node.status = 'This property could not be read by the bundled runtime.'; state.warnings.add('Some properties could not be read.'); }
    }
    return nodes;
  }
  function walk(nodes, callback) { for (const node of nodes) { callback(node); if (node.children) walk(node.children, callback); } }
  function fileReport(runtime, file) {
    const state = budget(4096), models = [], boards = [];
    for (let i = 0; i < file.artboardCount(); i++) {
      const board = file.artboardByIndex(i);
      try {
        const machines = [];
        for (let j = 0; j < board.stateMachineCount(); j++) {
          const definition = board.stateMachineByIndex(j);
          const machine = new runtime.StateMachineInstance(definition, board);
          try {
            const inputs = [];
            for (let k = 0; k < machine.inputCount(); k++) {
              const input = machine.input(k);
              inputs.push({ name: input.name, type: input.type === runtime.SMIInput.bool ? 'boolean' : input.type === runtime.SMIInput.trigger ? 'trigger' : 'number' });
            }
            machines.push({ name: definition.name, inputs });
          } finally { machine.delete(); }
        }
        let viewModel;
        try {
          // This is the file's assignment, not an instance chosen during playback.
          const assigned = file.defaultArtboardViewModel(board);
          viewModel = assigned ? assigned.name : null;
        } catch { state.warnings.add('Some artboard View Model assignments could not be read.'); }
        boards.push({ name: board.name, ...(viewModel !== undefined ? { viewModel } : {}), machines,
          animations: Array.from({ length: board.animationCount() }, (_, j) => board.animationByIndex(j).name) });
      } finally { board.delete(); }
    }
    const count = file.viewModelCount();
    for (let i = 0; i < Math.min(count, limits.models) && state.left > 0; i++) {
      const model = file.viewModelByIndex(i), instances = [];
      const definitions = model.getProperties();
      const exposed = definitions.slice(0, Math.max(0, state.left));
      state.left -= exposed.length;
      if (definitions.length > exposed.length) state.warnings.add('Some property definitions are omitted. This report is partial.');
      const names = model.getInstanceNames();
      for (let j = 0; j < Math.min(names.length, limits.instances) && state.left > 0; j++) {
        instances.push({ name: names[j], properties: capture(model.instanceByIndex(j), { state }) });
      }
      if (instances.length < names.length) state.warnings.add('Some named instances are omitted. This report is partial.');
      models.push({ name: model.name, properties: exposed, instances });
    }
    if (models.length < count) state.warnings.add('Some View Models are omitted. This report is partial.');
    return { version: 1, artboards: boards, models, warnings: [...state.warnings] };
  }
  function contract(report) {
    const values = new Map();
    const put = (path, value) => values.set(key(path), { path, value });
    for (const board of report.artboards) {
      put(['Artboard', board.name], 'artboard');
      if (Object.hasOwn(board, 'viewModel')) put(['Artboard', board.name, 'Assigned View Model'], board.viewModel === null ? 'Unassigned' : `View Model: ${board.viewModel}`);
      for (const name of board.animations) put(['Artboard', board.name, 'Animation', name], 'animation');
      for (const machine of board.machines) {
        const path = ['Artboard', board.name, 'State machine', machine.name];
        put(path, 'state machine');
        for (const input of machine.inputs) put([...path, 'Input', input.name], input.type);
      }
    }
    for (const model of report.models) {
      const path = ['View Model', model.name];
      put(path, 'view model');
      for (const property of model.properties) put([...path, 'Property', property.name], property.type);
      for (const instance of model.instances) {
        const prefix = [...path, 'Instance', instance.name];
        put(prefix, 'instance');
        walk(instance.properties, (node) => {
          if (node.type !== 'notice' && !node.path.some(segment => typeof segment === 'number')) {
            put([...prefix, ...node.path], node.type + (node.options ? `: ${JSON.stringify(node.options)}` : ''));
          }
        });
      }
    }
    return values;
  }
  function compare(previous, current) {
    const before = contract(previous), after = contract(current), changes = [];
    for (const [id, entry] of before) {
      const next = after.get(id);
      if (!next) changes.push({ kind: 'removed', path: entry.path, before: entry.value });
      else if (entry.value !== next.value) changes.push({ kind: 'changed', path: entry.path, before: entry.value, after: next.value });
    }
    for (const [id, entry] of after) if (!before.has(id)) changes.push({ kind: 'added', path: entry.path, after: entry.value });
    return changes;
  }
  return { limits, methods, key, budget, capture, walk, colorHex, colorValue, fileReport, compare };
})();
