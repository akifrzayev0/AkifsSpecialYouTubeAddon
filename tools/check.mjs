#!/usr/bin/env node
/*
 * Static checks for the whole project. Run: node tools/check.mjs
 *  - manifest.json references existing files; _locales define its __MSG_*__ texts (description <= 132 chars)
 *  - every extension .js file has valid syntax (node --check)
 *  - forbidden DOM/eval APIs are not used in extension code
 *  - i18n keys (tools/build-i18n.mjs --check)
 *  - companion host type-check (deno check) when Deno is available
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('✗ ' + msg);
};
const ok = (msg) => console.log('✓ ' + msg);

// 1) manifest references
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const refs = new Set();
Object.values(manifest.icons || {}).forEach((p) => refs.add(p));
Object.values((manifest.action && manifest.action.default_icon) || {}).forEach((p) => refs.add(p));
if (manifest.action && manifest.action.default_popup) refs.add(manifest.action.default_popup);
if (manifest.options_ui) refs.add(manifest.options_ui.page);
if (manifest.background) refs.add(manifest.background.service_worker);
for (const cs of manifest.content_scripts || []) [...(cs.js || []), ...(cs.css || [])].forEach((p) => refs.add(p));
for (const lang of fs.readdirSync(path.join(EXT, '_locales'))) refs.add(`_locales/${lang}/messages.json`);
const missingRefs = [...refs].filter((p) => !fs.existsSync(path.join(EXT, p)));
if (missingRefs.length) fail('manifest references missing files: ' + missingRefs.join(', '));
else ok(`manifest references ${refs.size} existing files`);

// _locales: the default locale defines every __MSG_name__ the manifest uses (other locales fall back to it);
// descriptions fit the 132 characters Chrome and the Web Store allow.
const msgNames = [...new Set([...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]))];
const failuresBeforeLocales = failures;
for (const lang of fs.readdirSync(path.join(EXT, '_locales'))) {
  const rel = `_locales/${lang}/messages.json`;
  let messages;
  try {
    messages = JSON.parse(fs.readFileSync(path.join(EXT, rel), 'utf8'));
  } catch (e) {
    fail(`${rel}: ${e.message}`);
    continue;
  }
  const missing = msgNames.filter((n) => !messages[n] || typeof messages[n].message !== 'string' || !messages[n].message.trim());
  if (missing.length && lang === manifest.default_locale) fail(`${rel} misses ${missing.join(', ')}`);
  else if (missing.length) console.warn(`! ${rel} misses ${missing.join(', ')} (Chrome shows the ${manifest.default_locale} text)`);
  const desc = messages.extDescription && messages.extDescription.message;
  if (desc && desc.length > 132) fail(`${rel}: extDescription has ${desc.length} characters (at most 132)`);
}
if (failures === failuresBeforeLocales) ok(`_locales define the ${msgNames.length} manifest messages`);

// importScripts in the service worker
const swPath = path.join(EXT, manifest.background.service_worker);
if (fs.existsSync(swPath)) {
  const sw = fs.readFileSync(swPath, 'utf8');
  const re = /importScripts\(([\s\S]*?)\);/g;
  let m;
  const imported = [];
  while ((m = re.exec(sw))) for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) imported.push(s[1]);
  const missingImports = imported.filter((p) => !fs.existsSync(path.resolve(path.dirname(swPath), p)));
  if (missingImports.length) fail('service worker importScripts missing: ' + missingImports.join(', '));
  else ok(`service worker imports ${imported.length} existing scripts`);
}

// html pages: referenced scripts/styles exist
for (const page of [manifest.action && manifest.action.default_popup, manifest.options_ui && manifest.options_ui.page].filter(Boolean)) {
  const p = path.join(EXT, page);
  if (!fs.existsSync(p)) continue;
  const html = fs.readFileSync(p, 'utf8');
  const srcs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((x) => x[1]);
  const miss = srcs.filter((s) => !fs.existsSync(path.resolve(path.dirname(p), s)));
  if (miss.length) fail(`${page} references missing files: ${miss.join(', ')}`);
  if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(html)) fail(`${page} has an inline <script> (blocked by MV3 CSP)`);
  if (/\son[a-z]+="/i.test(html)) fail(`${page} has inline event handler attributes (blocked by MV3 CSP)`);
}

// 2) syntax + forbidden APIs
const jsFiles = [];
const walk = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.js')) jsFiles.push(p);
  }
};
walk(EXT);
let syntaxBad = 0;
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    syntaxBad++;
    fail(`syntax error in ${path.relative(ROOT, f)}\n${r.stderr}`);
  }
}
if (!syntaxBad) ok(`${jsFiles.length} extension JS files parse`);

const FORBIDDEN = [
  [/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(/, 'innerHTML/outerHTML/insertAdjacentHTML (Trusted Types)'],
  [/document\.write\s*\(/, 'document.write'],
  [/\beval\s*\(/, 'eval'],
  [/new\s+Function\s*\(/, 'new Function'],
  [/new\s+DOMParser\s*\(/, 'DOMParser (use AYT.dom)'],
];
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const [re, label] of FORBIDDEN) if (re.test(src)) fail(`${path.relative(ROOT, f)} uses ${label}`);
}
ok('forbidden-API scan done');

// 3) i18n
const i18n = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-i18n.mjs'), process.argv.includes('--strict') ? '--strict' : '--check'], { encoding: 'utf8' });
process.stdout.write(i18n.stdout);
process.stderr.write(i18n.stderr);
if (i18n.status !== 0) fail('i18n check failed');

// 4) companion host
const hostTs = path.join(ROOT, 'companion', 'host', 'host.ts');
if (fs.existsSync(hostTs)) {
  // shell:true joins args with spaces unquoted, and the project path contains spaces -> quote it there.
  const useShell = process.platform === 'win32';
  const d = spawnSync('deno', ['check', '--quiet', useShell ? `"${hostTs}"` : hostTs], { encoding: 'utf8', shell: useShell });
  if (d.error) console.warn('! deno not available, skipped host type-check');
  else if (d.status !== 0) fail('deno check failed:\n' + d.stdout + d.stderr);
  else ok('companion host type-checks');
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
