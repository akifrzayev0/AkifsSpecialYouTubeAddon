/*
 * Akif's Special YouTube Addon — tiny runtime i18n.
 * Dictionaries live in shared/i18n/<lang>.js and call AYT.i18n.register(lang, () => ({...})).
 * A dictionary registered as a function is only built when its language is first used, so pages
 * don't pay for the six languages they never show. English ('en') is the source and fallback language.
 *
 *   AYT.t('video.panelTitle')                  -> "Download video"
 *   AYT.t('job.eta', { time: '1:20' })         -> "1:20 left"
 *   AYT.t('pages.backup.imported', { count })  -> plural form, see below
 *
 * Placeholders use {name}. Missing keys fall back to English, then to the key itself.
 *
 * Plurals: when params.count is a finite number, t(key) looks for "<key>.<category>" where category is
 * what Intl.PluralRules(<UI language>).select(count) returns (zero/one/two/few/many/other). If that form is
 * missing it uses the plain "<key>" (a count-safe text such as "Settings imported: {count}"), then
 * "<key>.other"; then the same lookups in English. English plural keys always come as .one + .other;
 * tools/build-i18n.mjs checks that each translation has every category its language needs.
 */
(function (g) {
  'use strict';
  const AYT = (g.AYT = g.AYT || {});
  if (AYT.i18n) return;

  const SUPPORTED = ['en', 'az', 'tr', 'ru', 'fr', 'de', 'es'];
  const dicts = {}; // code -> null-prototype object (built)
  const pending = {}; // code -> [factory] (registered lazily, built on first use)
  const pluralRules = {};
  let current = 'en';
  const listeners = new Set();

  /** 'de-AT' / 'de_AT' -> 'de' when that language is supported, else null. */
  function supportedBase(tag) {
    const base = String(tag || '').toLowerCase().split(/[-_]/)[0];
    return SUPPORTED.includes(base) ? base : null;
  }

  /**
   * The supported language 'auto' stands for: the first of Chrome's preferred languages (Settings → Languages,
   * navigator.languages, the same in every context) that we support, then Chrome's own UI language, then English.
   * The preferred list comes first because Chrome can't show its UI in every language (e.g. Azerbaijani), so
   * the UI language is often a second choice.
   */
  function browserLanguage() {
    try {
      const preferred = g.navigator && g.navigator.languages;
      if (preferred && typeof preferred.length === 'number') {
        for (const tag of Array.from(preferred)) {
          const code = supportedBase(tag);
          if (code) return code;
        }
      }
    } catch (_) {
      /* ignore */
    }
    try {
      if (g.chrome && g.chrome.i18n && typeof g.chrome.i18n.getUILanguage === 'function') {
        const code = supportedBase(g.chrome.i18n.getUILanguage());
        if (code) return code;
      }
    } catch (_) {
      /* ignore */
    }
    return supportedBase(g.navigator && g.navigator.language) || 'en';
  }

  /** The dictionary for a language (builds lazily registered parts first); undefined when unknown. */
  function dict(code) {
    const queue = pending[code];
    if (queue) {
      delete pending[code];
      for (const factory of queue) {
        try {
          dicts[code] = Object.assign(dicts[code] || Object.create(null), factory());
        } catch (e) {
          console.error('[AYT] i18n: dictionary failed to load', code, e);
        }
      }
    }
    return dicts[code];
  }

  /** CLDR plural category of `count` in a language ('one', 'few', 'other', ...). */
  function pluralCategory(count, code) {
    const lang = code || current;
    let rules = pluralRules[lang];
    if (rules === undefined) {
      try {
        rules = new Intl.PluralRules(lang);
      } catch (_) {
        rules = null;
      }
      pluralRules[lang] = rules;
    }
    if (rules) return rules.select(count);
    return count === 1 ? 'one' : 'other';
  }

  /** Text for `key` in one language, or undefined. count (number|undefined) selects a plural form. */
  function find(code, key, count) {
    const d = dict(code);
    if (!d) return undefined;
    if (count !== undefined) {
      const form = d[key + '.' + pluralCategory(count, code)];
      if (form != null) return form;
    }
    return d[key] != null ? d[key] : d[key + '.other'];
  }

  const i18n = {
    SUPPORTED,

    /** Adds strings for a language. dict: an object, or a function returning one (built on first use). */
    register(code, d) {
      if (typeof d === 'function') {
        (pending[code] = pending[code] || []).push(d);
        return;
      }
      dict(code); // keep registration order: earlier lazy parts first, then these strings
      dicts[code] = Object.assign(dicts[code] || Object.create(null), d);
    },

    /** 'auto' | code -> concrete supported code ('auto': see browserLanguage()) */
    resolve(pref) {
      if (pref && pref !== 'auto' && SUPPORTED.includes(pref)) return pref;
      return browserLanguage();
    },

    setLanguage(pref) {
      const next = i18n.resolve(pref);
      const changed = next !== current;
      current = next;
      if (changed) listeners.forEach((fn) => { try { fn(current); } catch (e) { console.error(e); } });
      return current;
    },

    get language() {
      return current;
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** True when the key (or its plural forms) exists in the UI language or in English. */
    has(key) {
      return find(current, key) != null || find('en', key) != null;
    },

    pluralCategory,

    t(key, params) {
      const count = params && typeof params.count === 'number' && isFinite(params.count) ? params.count : undefined;
      let s = find(current, key, count);
      if (s == null && current !== 'en') s = find('en', key, count);
      if (s == null) return key;
      if (params) {
        s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
      }
      return s;
    },

    /** All keys known for a language (used by the i18n checker). */
    keys(code) {
      return Object.keys(dict(code || 'en') || {});
    },
  };

  AYT.i18n = i18n;
  AYT.t = (key, params) => i18n.t(key, params);
})(globalThis);
