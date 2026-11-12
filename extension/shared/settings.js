/*
 * Akif's Special YouTube Addon — settings store (chrome.storage.local, one key per setting).
 *
 *   await AYT.settings.load();
 *   AYT.settings.get('hideComments');
 *   await AYT.settings.set('hideComments', true);
 *   AYT.settings.onChange((changes, all) => { ... });   // changes = { name: newValue }
 *
 * Works in content scripts, extension pages and the service worker.
 */
(function (g) {
  'use strict';
  const AYT = (g.AYT = g.AYT || {});
  if (AYT.settings) return;

  const DEFAULTS = AYT.DEFAULT_SETTINGS;
  const PREFIX = AYT.STORAGE.SETTINGS_PREFIX;
  // Storage keys of the settings. load() asks for exactly these: chrome.storage.local also holds the job
  // history (up to 150 jobs, each with its file list), which every page load would otherwise deserialize.
  const KEYS = Object.keys(DEFAULTS).map((n) => PREFIX + n);
  const listeners = new Set();
  let cache = null;
  let loading = null;

  /** Coerce a stored value to the type of its default; fall back to the default when invalid. */
  function sanitize(name, value) {
    const def = DEFAULTS[name];
    if (value === undefined) return def;
    if (Array.isArray(def)) return Array.isArray(value) ? value.slice() : def.slice();
    if (typeof def === 'number') {
      const n = Number(value);
      return isFinite(n) ? n : def;
    }
    if (typeof def === 'boolean') return typeof value === 'boolean' ? value : def;
    if (typeof def === 'string') return typeof value === 'string' ? value : def;
    return value;
  }

  function fromStorage(all) {
    const s = {};
    for (const name of Object.keys(DEFAULTS)) {
      s[name] = sanitize(name, all[PREFIX + name]);
    }
    return s;
  }

  function emit(changes) {
    if (!Object.keys(changes).length) return;
    const snapshot = Object.assign({}, cache);
    listeners.forEach((fn) => {
      try {
        fn(changes, snapshot);
      } catch (e) {
        console.error('[AYT] settings listener failed', e);
      }
    });
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !cache) return;
      const diff = {};
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (!key.startsWith(PREFIX)) continue;
        const name = key.slice(PREFIX.length);
        if (!(name in DEFAULTS)) continue;
        const v = sanitize(name, newValue);
        if (JSON.stringify(cache[name]) !== JSON.stringify(v)) {
          cache[name] = v;
          diff[name] = v;
        }
      }
      emit(diff);
    });
  } catch (e) {
    console.warn('[AYT] chrome.storage unavailable', e);
  }

  AYT.settings = {
    DEFAULTS,

    load() {
      if (cache) return Promise.resolve(Object.assign({}, cache));
      if (!loading) {
        loading = chrome.storage.local
          .get(KEYS)
          .then((all) => {
            cache = fromStorage(all || {});
            return Object.assign({}, cache);
          })
          .catch((e) => {
            console.warn('[AYT] settings load failed, using defaults', e);
            cache = Object.assign({}, DEFAULTS);
            return Object.assign({}, cache);
          });
      }
      return loading;
    },

    /** Synchronous read (call load() once first). */
    get(name) {
      if (!(name in DEFAULTS)) throw new Error('Unknown setting: ' + name);
      return cache ? cache[name] : DEFAULTS[name];
    },

    all() {
      return Object.assign({}, cache || DEFAULTS);
    },

    async set(name, value) {
      return AYT.settings.setMany({ [name]: value });
    },

    async setMany(obj) {
      await AYT.settings.load();
      const toStore = {};
      const diff = {};
      for (const [name, value] of Object.entries(obj)) {
        if (!(name in DEFAULTS)) throw new Error('Unknown setting: ' + name);
        const v = sanitize(name, value);
        toStore[PREFIX + name] = v;
        if (JSON.stringify(cache[name]) !== JSON.stringify(v)) diff[name] = v;
        cache[name] = v;
      }
      await chrome.storage.local.set(toStore);
      // onChanged will also fire in this context, but cache is already updated so it emits nothing;
      // emit locally so the caller's own listeners update immediately.
      emit(diff);
    },

    async reset() {
      await chrome.storage.local.remove(KEYS);
      const diff = {};
      for (const name of Object.keys(DEFAULTS)) {
        if (JSON.stringify(cache && cache[name]) !== JSON.stringify(DEFAULTS[name])) diff[name] = DEFAULTS[name];
      }
      cache = fromStorage({});
      emit(diff);
    },

    /** Export all settings as a plain object (for backup). */
    export() {
      return Object.assign({}, cache || DEFAULTS);
    },

    /** Import from a plain object; unknown keys are ignored. */
    async import(obj) {
      const clean = {};
      for (const name of Object.keys(DEFAULTS)) if (obj && name in obj) clean[name] = obj[name];
      await AYT.settings.setMany(clean);
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
})(globalThis);
