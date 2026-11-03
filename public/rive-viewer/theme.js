/* Apply the saved preference before styles load to avoid a theme flash. */
(() => {
  'use strict';
  const storageKey = 'rive-viewer-theme';
  const normalize = (value) => value === 'light' || value === 'dark' ? value : 'system';
  let preference = 'system';
  try { preference = normalize(localStorage.getItem(storageKey)); } catch { /* Storage can be disabled. */ }

  function apply(value) {
    preference = normalize(value);
    if (preference === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = preference;
    const select = document.getElementById('theme');
    if (select) select.value = preference;
  }
  apply(preference);

  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('theme');
    if (!select) return;
    select.value = preference;
    select.addEventListener('change', () => {
      apply(select.value);
      try { localStorage.setItem(storageKey, preference); } catch { /* The current page still works. */ }
    });
  });
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null) apply(event.newValue);
  });
})();
