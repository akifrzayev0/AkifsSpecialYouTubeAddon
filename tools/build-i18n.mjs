#!/usr/bin/env node
/*
 * Builds extension/shared/i18n/<lang>.js from i18n/<lang>.json.
 *
 *   node tools/build-i18n.mjs            rebuild i18n/en.json from i18n/parts/en.*.json (if parts exist), then build all languages
 *   node tools/build-i18n.mjs --check    also fail on placeholder mismatches, empty strings, bad plural keys and
 *                                        t('key') calls whose key is missing from English
 *   node tools/build-i18n.mjs --strict   like --check, but missing/extra translations are errors too (use for releases)
 *
 * English (en) is the source of truth: i18n/en.json is generated from the part files. Other languages missing
 * a key fall back to English at runtime, but --check reports them so they can be translated.
 *
 * Plural strings. Code calls t('<key>', { count }) and English defines "<key>.one" + "<key>.other".
 * A translation provides EITHER every CLDR plural form its language needs as "<key>.<form>"
 * (the list is printed by this script, e.g. ru: one/few/many/other) OR one count-safe "<key>" text that reads
 * well for every number ("Settings imported: {count}"). Every form keeps the placeholders of "<key>.other".
 * At runtime AYT.t picks the form with Intl.PluralRules (see extension/shared/i18n.js).
 *
 * Keyboard shortcuts. The command names Chrome shows on chrome://extensions/shortcuts come from
 * extension/_locales/<lang>/messages.json (cmd*). They are copied from pages.cmd.* in i18n/<lang>.json, so
 * Settings and Chrome always use the same words: translate pages.cmd.*, not the cmd* entries.
 *
 * The generated dictionaries register a function, so a page only builds the languages it actually shows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'i18n');
const OUT = path.join(ROOT, 'extension', 'shared', 'i18n');
const EXT = path.join(ROOT, 'extension');
const LANGS = ['en', 'az', 'tr', 'ru', 'fr', 'de', 'es'];
const FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
const check = process.argv.includes('--check') || process.argv.includes('--strict');
// --strict: missing/extra translations are errors too (use for releases). --check: they are warnings.
const strict = process.argv.includes('--strict');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Writes only when the content changes (keeps concurrent runs and file watchers quiet). */
function writeIfChanged(file, text) {
  try {
    if (fs.readFileSync(file, 'utf8') === text) return false;
  } catch (_) {
    /* new file */
  }
  fs.writeFileSync(file, text);
  return true;
}

/** Plural forms a language needs, in CLDR order (en: one, other; ru: one, few, many, other). */
function pluralForms(lang) {
  const cats = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
  return FORMS.filter((c) => cats.includes(c));
}

let problems = 0;
/** An error with --check/--strict, a warning otherwise. */
const problem = (msg) => {
  if (!check) return console.warn('! ' + msg);
  problems++;
  console.error('✗ ' + msg);
};
const list = (keys, max) => keys.slice(0, max).join(', ') + (keys.length > max ? ' …' : '');

// 1) parts -> en.json (the parts are the source; a key removed from a part disappears from en.json)
const partsDir = path.join(SRC, 'parts');
if (fs.existsSync(partsDir)) {
  const parts = fs.readdirSync(partsDir).filter((f) => /^en\.[\w-]+\.json$/.test(f)).sort();
  if (parts.length) {
    const merged = {};
    const owner = {};
    for (const f of parts) {
      const data = readJson(path.join(partsDir, f));
      for (const [k, v] of Object.entries(data)) {
        if (owner[k] && merged[k] !== v) console.warn(`! key "${k}" defined in ${owner[k]} and ${f} with different text; using ${f}`);
        owner[k] = f;
        merged[k] = v;
      }
    }
    const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
    writeIfChanged(path.join(SRC, 'en.json'), JSON.stringify(sorted, null, 2) + '\n');
    console.log(`merged ${parts.length} part file(s) into i18n/en.json (${Object.keys(sorted).length} keys)`);
  }
}

const en = readJson(path.join(SRC, 'en.json'));
const enKeys = Object.keys(en);
const placeholders = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');

// 2) plural keys: "<base>.one" + "<base>.other" in English
const families = new Set();
for (const k of enKeys) {
  const m = /^(.+)\.one$/.exec(k);
  if (m && `${m[1]}.other` in en) families.add(m[1]);
}
/** "x.few" -> "x" when x is a plural key, else null */
const familyOf = (k) => {
  const m = /^(.+)\.(zero|one|two|few|many|other)$/.exec(k);
  return m && families.has(m[1]) ? m[1] : null;
};
/** The English text whose placeholders a translated key must keep. */
const source = (k) => (families.has(k) ? en[`${k}.other`] : familyOf(k) ? en[`${familyOf(k)}.other`] : en[k]);
const enForms = pluralForms('en');
for (const base of families) {
  if (base in en) problem(`en: "${base}" is both a plain key and a plural key (${base}.one/.other); remove the plain one`);
  for (const f of FORMS) {
    const k = `${base}.${f}`;
    if (!(k in en)) continue;
    if (!enForms.includes(f)) problem(`en: "${k}" — English only uses the plural forms ${enForms.join(', ')}`);
    else if (placeholders(en[k]) !== placeholders(source(k))) problem(`en: "${k}" must use the same placeholders as "${base}.other"`);
  }
}
if (families.size) {
  const forms = LANGS.filter((l) => l !== 'en').map((l) => `${l}: ${pluralForms(l).join('/')}`);
  console.log(
    `${families.size} plural key(s), used as t(key, { count }): ${list([...families], 20)}\n` +
      `  a translation adds "<key>.<form>" for each form of its language (${forms.join('; ')})\n` +
      '  or one count-safe "<key>" text; every form keeps the placeholders of "<key>.other"'
  );
}

// 3) dictionaries
fs.mkdirSync(OUT, { recursive: true });
const translations = { en };
for (const lang of LANGS) {
  const file = path.join(SRC, `${lang}.json`);
  const dict = lang === 'en' ? Object.assign({}, en) : fs.existsSync(file) ? readJson(file) : {};
  if (lang !== 'en') {
    translations[lang] = Object.assign({}, dict);
    const forms = pluralForms(lang);
    const allowed = (k) => {
      const base = familyOf(k);
      if (base) return forms.includes(k.slice(base.length + 1));
      return families.has(k) || k in en; // a plural key's plain "<key>" is its count-safe form
    };
    const missing = enKeys.filter((k) => !familyOf(k) && !(k in dict));
    const incomplete = [];
    for (const base of families) {
      if (base in dict) continue;
      const have = forms.filter((f) => `${base}.${f}` in dict);
      if (!have.length) missing.push(`${base}.{${forms.join(',')}}`);
      else if (have.length < forms.length) incomplete.push(`${base}.{${forms.filter((f) => !have.includes(f)).join(',')}}`);
    }
    const extra = Object.keys(dict).filter((k) => !allowed(k));
    const badPh = Object.keys(dict).filter((k) => allowed(k) && placeholders(dict[k]) !== placeholders(source(k)));
    const empty = Object.keys(dict).filter((k) => typeof dict[k] !== 'string' || !dict[k].trim());
    if (missing.length || incomplete.length || extra.length || badPh.length || empty.length) {
      const msg = `${lang}: ${missing.length} missing, ${incomplete.length} incomplete plural, ${extra.length} extra, ${badPh.length} placeholder mismatches, ${empty.length} empty`;
      const isError = check && (strict || badPh.length || empty.length);
      const out = isError ? console.error : console.warn;
      out((isError ? '✗ ' : '! ') + msg);
      if (isError) problems++;
      if (check) {
        if (missing.length) out('  missing:', list(missing, 30));
        if (incomplete.length) out('  incomplete plural forms:', list(incomplete, 30));
        if (extra.length) out('  extra (left out of the build):', list(extra, 30));
        if (badPh.length) out('  placeholders:', badPh.join(', '));
        if (empty.length) out('  empty:', empty.join(', '));
      }
    }
    for (const k of Object.keys(dict)) if (!allowed(k)) delete dict[k];
  }
  const ordered = Object.fromEntries(Object.keys(dict).sort().map((k) => [k, dict[k]]));
  const js =
    `/* Generated by tools/build-i18n.mjs from i18n/${lang}.json — do not edit by hand. */\n` +
    `(function (g) {\n  'use strict';\n  // Built on the first use of this language (AYT.i18n.register accepts a function).\n` +
    `  g.AYT.i18n.register(${JSON.stringify(lang)}, function () {\n    return ${JSON.stringify(ordered, null, 2).replace(/\n/g, '\n    ')};\n  });\n})(globalThis);\n`;
  writeIfChanged(path.join(OUT, `${lang}.js`), js);
}
console.log(`built ${LANGS.length} dictionaries -> extension/shared/i18n/`);

// 4) shortcut names on chrome://extensions/shortcuts: _locales/<lang> cmd* <- pages.cmd.* of i18n/<lang>.json
try {
  const manifest = readJson(path.join(EXT, 'manifest.json'));
  const cmds = [];
  for (const [name, c] of Object.entries(manifest.commands || {})) {
    const m = /^__MSG_(cmd(\w+))__$/.exec((c && c.description) || '');
    if (!m) continue;
    const key = 'pages.cmd.' + m[2].charAt(0).toLowerCase() + m[2].slice(1);
    if (key in en) cmds.push([m[1], key]);
    else problem(`command "${name}" uses ${m[1]}, but i18n has no "${key}" to copy its name from`);
  }
  let synced = 0;
  for (const lang of LANGS) {
    const file = path.join(EXT, '_locales', lang, 'messages.json');
    if (!fs.existsSync(file)) continue;
    const messages = readJson(file);
    let changed = false;
    for (const [msg, key] of cmds) {
      const text = translations[lang] && translations[lang][key];
      if (typeof text !== 'string' || !text.trim()) continue; // not translated yet: keep Chrome's current name
      const value = text.replace(/\$/g, '$$$$'); // "$" starts a placeholder in chrome.i18n messages
      if (!messages[msg] || messages[msg].message !== value) {
        messages[msg] = Object.assign({}, messages[msg], { message: value });
        changed = true;
      }
    }
    if (changed && writeIfChanged(file, JSON.stringify(messages, null, 2) + '\n')) synced++;
  }
  if (synced) console.log(`copied the shortcut names (pages.cmd.*) into ${synced} _locales file(s)`);
} catch (e) {
  problem('could not update the shortcut names in extension/_locales: ' + e.message);
}

if (check) {
  // every t('key') used in the code must exist in en.json
  const used = new Map();
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'i18n' && dir.endsWith('shared')) continue;
        walk(p);
      } else if (/\.(js|html)$/.test(ent.name)) {
        const src = fs.readFileSync(p, 'utf8');
        const re = /(?:\bt|AYT\.t|i18n\.t)\(\s*['"]([a-zA-Z0-9_.-]+)['"]/g;
        let m;
        while ((m = re.exec(src))) {
          if (!used.has(m[1])) used.set(m[1], path.relative(ROOT, p));
        }
        const re2 = /data-i18n(?:-[a-z]+)?="([a-zA-Z0-9_.-]+)"/g;
        while ((m = re2.exec(src))) if (!used.has(m[1])) used.set(m[1], path.relative(ROOT, p));
      }
    }
  };
  walk(EXT);
  const unknown = [...used.entries()].filter(([k]) => !(k in en) && !families.has(k));
  if (unknown.length) {
    problems++;
    console.error(`✗ ${unknown.length} key(s) used in code but missing from i18n/en.json:`);
    for (const [k, f] of unknown) console.error(`  ${k}   (${f})`);
  }
  const unused = enKeys.filter((k) => !used.has(k) && !used.has(familyOf(k)));
  if (unused.length) console.warn(`! ${unused.length} key(s) in en.json not found literally in code (may be built dynamically): ${list(unused, 40)}`);
  if (problems) {
    console.error(`i18n check failed (${problems} problem group(s))`);
    process.exit(1);
  }
  console.log('✓ i18n check passed');
}
