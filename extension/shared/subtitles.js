/*
 * Akif's Special YouTube Addon — caption format converters (owner: MEDIA).
 *
 * Pure functions: no DOM, no DOMParser, no network. Works in content scripts, extension pages,
 * service workers and Node (unit tests load this classic script into a vm context).
 *
 *   const cues = AYT.subtitles.parse(body, 'json3');            // [{ start, end, text }] in seconds
 *   const srt = AYT.subtitles.toSrt(cues);
 *   const { text, mime, ext } = AYT.subtitles.convert(body, 'json3', 'srt', { lang: 'en' });
 *
 * Input formats : json3, vtt, srv3, srv2, srv1, ttml, srt (sniffed from the body; the declared format is a hint).
 * Output formats: srt, vtt, ttml, srv3, txt, json3.
 *
 * Normalization (applied by parse and by every writer):
 *  - text is cleaned (tags stripped by the parsers, entities decoded, zero-width/control characters removed,
 *    whitespace collapsed, empty lines dropped); cues without text are dropped (e.g. json3 "\n" append events);
 *  - cues that start at the same time (several caption windows) are merged into one multi-line cue;
 *  - overlaps are clipped: a cue ends when the next one starts (auto-generated "rolling" captions overlap);
 *  - "rolling" VTT (YouTube's auto-generated VTT repeats the previous line in each cue) is de-duplicated.
 *
 * Errors thrown carry `.code`: 'parse' (malformed input), 'empty' (no cues), 'format' (unsupported format).
 */
(function (g) {
  'use strict';
  const AYT = (g.AYT = g.AYT || {});
  if (AYT.subtitles) return;

  /** Output formats offered to users (in UI order). */
  const FORMATS = Object.freeze(['srt', 'vtt', 'ttml', 'srv3', 'txt']);
  /** Formats YouTube's /api/timedtext can serve natively. */
  const NATIVE = Object.freeze(['json3', 'vtt', 'srv1', 'srv2', 'srv3', 'ttml']);

  const FALLBACK_MIME = {
    srt: 'application/x-subrip',
    vtt: 'text/vtt',
    ttml: 'application/ttml+xml',
    srv3: 'application/octet-stream',
    json3: 'application/octet-stream',
    txt: 'text/plain',
  };

  const DEFAULT_CUE_SECONDS = 3; // duration for cues whose end time is unknown
  const SAME_START = 0.0005; // seconds: cues closer than this are considered simultaneous
  const ROLLING_RATIO = 0.3; // share of cues repeating the previous cue's last line => rolling captions

  /* ------------------------------------------------------------------ helpers */

  function makeError(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  function normFormat(fmt) {
    const f = String(fmt || '').trim().toLowerCase().replace(/^\./, '');
    if (f === 'webvtt') return 'vtt';
    if (f === 'text' || f === 'plain') return 'txt';
    if (f === 'xml' || f === 'dfxp') return 'ttml';
    if (f === 'json') return 'json3';
    return f;
  }

  const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '‎', rlm: '‏', shy: '' };

  /** Decodes XML/HTML character references (&amp; &#39; &#x2019; ...). Unknown names are kept. */
  function decodeEntities(s) {
    return String(s).replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,15});/g, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return m;
        return String.fromCodePoint(cp);
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : m;
    });
  }

  /** Escapes text for XML text nodes and attribute values. */
  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  }

  /** Characters that make a line "visually empty". */
  const INVISIBLE_LINE = /^[\s​-‏‪-‮⁠-⁩﻿]*$/;

  /**
   * Cleans cue text: unifies newlines, removes zero-width spaces / BOMs / C0 controls, turns tabs and
   * non-breaking spaces into spaces, collapses runs of spaces, trims lines and drops empty lines.
   */
  function cleanText(text) {
    let s = String(text == null ? '' : text);
    if (typeof s.toWellFormed === 'function') s = s.toWellFormed();
    return s
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​﻿]/g, '')
      .replace(/[\t  -   ]/g, ' ')
      .split('\n')
      .map((line) => line.replace(/ {2,}/g, ' ').trim())
      .filter((line) => line && !INVISIBLE_LINE.test(line))
      .join('\n');
  }

  const round3 = (x) => Math.round(x * 1000) / 1000;
  const toMs = (sec) => Math.max(0, Math.round(sec * 1000));
  const pad = (n, w) => String(n).padStart(w, '0');

  /** Seconds -> "HH:MM:SS<sep>mmm" (sep ',' for SRT, '.' for VTT/TTML). */
  function formatTime(sec, sep) {
    let ms = toMs(sec);
    const h = Math.floor(ms / 3600000);
    ms -= h * 3600000;
    const m = Math.floor(ms / 60000);
    ms -= m * 60000;
    const s = Math.floor(ms / 1000);
    ms -= s * 1000;
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + (sep || '.') + pad(ms, 3);
  }

  /** "01:02:03.456", "02:03.456", "01:02:03,456", "3.5" -> seconds (NaN when invalid). */
  function parseClock(str) {
    const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,9}))?\s*$/.exec(String(str));
    if (!m) {
      const plain = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(String(str));
      return plain ? Number(plain[1]) : NaN;
    }
    const frac = m[4] ? Number('0.' + m[4]) : 0;
    return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
  }

  function parseAttrs(s) {
    const out = {};
    const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(s || ''))) out[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
    return out;
  }

  /** Removes markup from an XML/HTML fragment; <br> becomes a newline. */
  function stripMarkup(fragment) {
    return String(fragment)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\/?[a-zA-Z][^>]*>/g, '');
  }

  /* ------------------------------------------------------------------ normalization */

  function splitLines(text) {
    return text ? text.split('\n') : [];
  }

  /** Largest k so that the first k lines of `cur` equal the last k lines of `prev`. */
  function overlapLines(prev, cur) {
    const max = Math.min(prev.length, cur.length);
    for (let k = max; k > 0; k--) {
      let same = true;
      for (let i = 0; i < k; i++) {
        if (prev[prev.length - k + i] !== cur[i]) {
          same = false;
          break;
        }
      }
      if (same) return k;
    }
    return 0;
  }

  /**
   * True when cues look like YouTube's rolling captions: a cue starts with the previous cue's last line and either
   * adds a line below it or is one of the ~10 ms "transition" cues. (A song repeating a one-line caption is not
   * rolling: those cues are kept.)
   */
  function isRolling(cues) {
    const list = cues.filter((c) => c.text);
    if (list.length < 4) return false;
    let hits = 0;
    for (let i = 1; i < list.length; i++) {
      const prev = splitLines(list[i - 1].text);
      const cur = splitLines(list[i].text);
      if (!prev.length || !cur.length || cur[0] !== prev[prev.length - 1]) continue;
      const transition = isFinite(list[i].end) && list[i].end - list[i].start <= 0.05;
      if (cur.length >= 2 || transition) hits++;
    }
    return hits / (list.length - 1) >= ROLLING_RATIO;
  }

  /**
   * Drops the lines a rolling cue repeats from the previous cue (and cues that only repeat).
   * An empty cue means the caption window was cleared: the next cue starts fresh.
   */
  function deroll(cues) {
    const out = [];
    let prevLines = [];
    for (const c of cues) {
      const lines = splitLines(c.text);
      if (!lines.length) {
        prevLines = [];
        out.push(c);
        continue;
      }
      const k = overlapLines(prevLines, lines);
      prevLines = lines;
      const rest = lines.slice(k);
      if (!rest.length) continue;
      out.push({ start: c.start, end: c.end, text: rest.join('\n') });
    }
    return out;
  }

  /**
   * Cleans, sorts, merges simultaneous cues, de-rolls rolling captions, clips overlaps and fills unknown ends.
   * Accepts any [{start, end, text}] (seconds) and returns a new, clean array (times rounded to ms).
   */
  function normalize(list) {
    const cues = [];
    (Array.isArray(list) ? list : []).forEach((c, i) => {
      if (!c) return;
      const start = Number(c.start);
      if (!isFinite(start) || start < 0) return;
      const end = Number(c.end);
      // Empty cues are kept until de-rolling (they clear the caption window), then dropped.
      cues.push({ start: round3(start), end: isFinite(end) ? round3(end) : NaN, text: cleanText(c.text), i });
    });
    cues.sort((a, b) => a.start - b.start || a.i - b.i);

    let merged = [];
    for (const c of cues) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(c.start - last.start) < SAME_START) {
        // Simultaneous cues (several caption windows): one multi-line cue lasting as long as the longest one.
        if (c.text) {
          const have = new Set(splitLines(last.text));
          const add = splitLines(c.text).filter((l) => !have.has(l));
          if (add.length) last.text = last.text ? last.text + '\n' + add.join('\n') : add.join('\n');
          if (isFinite(c.end) && (!last.hadText || !isFinite(last.end) || c.end > last.end)) last.end = c.end;
          last.hadText = true;
        }
        continue;
      }
      merged.push({ start: c.start, end: c.end, text: c.text, hadText: !!c.text });
    }

    if (isRolling(merged)) merged = deroll(merged);
    merged = merged.filter((c) => c.text).map((c) => ({ start: c.start, end: c.end, text: c.text }));

    for (let i = 0; i < merged.length; i++) {
      const c = merged[i];
      const next = merged[i + 1];
      if (!isFinite(c.end) || c.end <= c.start) c.end = next ? Math.min(next.start, c.start + DEFAULT_CUE_SECONDS) : c.start + DEFAULT_CUE_SECONDS;
      if (next && c.end > next.start) c.end = next.start;
      c.end = round3(c.end);
    }
    return merged;
  }

  /* ------------------------------------------------------------------ parsers */

  /** YouTube json3: { events: [{ tStartMs, dDurationMs, segs: [{ utf8, tOffsetMs }], aAppend }] }. */
  function parseJson3(body) {
    let data = body;
    if (typeof body === 'string') {
      try {
        data = JSON.parse(body);
      } catch (e) {
        throw makeError('parse', 'Invalid json3 subtitles: ' + e.message);
      }
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.events)) throw makeError('parse', 'Invalid json3 subtitles: no events');
    const cues = [];
    for (const ev of data.events) {
      if (!ev || !Array.isArray(ev.segs)) continue; // window/style definition events
      const start = Number(ev.tStartMs);
      if (!isFinite(start)) continue;
      const text = ev.segs.map((s) => (s && typeof s.utf8 === 'string' ? s.utf8 : '')).join('');
      const dur = Number(ev.dDurationMs);
      cues.push({ start: start / 1000, end: isFinite(dur) && dur > 0 ? (start + dur) / 1000 : NaN, text });
    }
    return cues;
  }

  const TIMING_RE = /^\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,9})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,9})?)/;

  /** WebVTT and SRT share the "timing line + payload until an empty line" structure. */
  function parseTimedBlocks(body, isVtt) {
    const lines = String(body).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    const cues = [];
    let i = 0;
    if (isVtt && /^WEBVTT/.test(lines[0] || '')) {
      while (i < lines.length && lines[i] !== '') i++; // header block
    }
    // SRT ends a cue at a blank line; VTT only at an empty line (YouTube's VTT uses " " payload lines).
    const ends = isVtt ? (l) => l === '' : (l) => l.trim() === '';
    while (i < lines.length) {
      const m = TIMING_RE.exec(lines[i]);
      i++;
      if (!m) continue; // cue ids, NOTE/STYLE/REGION blocks, garbage
      const payload = [];
      while (i < lines.length && !ends(lines[i])) {
        if (TIMING_RE.test(lines[i])) break; // tolerate a missing separator line
        payload.push(lines[i]);
        i++;
      }
      // SRT: a trailing numeric line right before the next timing line is the next cue's id.
      if (!isVtt && payload.length > 1 && /^\d+$/.test(payload[payload.length - 1].trim()) && TIMING_RE.test(lines[i] || '')) payload.pop();
      const raw = payload.join('\n');
      const text = decodeEntities(stripMarkup(raw.replace(/<\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}>/g, '')));
      cues.push({ start: parseClock(m[1]), end: parseClock(m[2]), text });
    }
    return cues;
  }

  /** srv3: <timedtext format="3"><body><p t="ms" d="ms"><s>word</s>...</p></body></timedtext> */
  function parseSrv3(body) {
    const s = String(body);
    const cues = [];
    const re = /<p\b([^>]*?)(?:\/>|>([\s\S]*?)<\/p\s*>)/g;
    let m;
    while ((m = re.exec(s))) {
      const a = parseAttrs(m[1]);
      const t = Number(a.t);
      if (!isFinite(t)) continue;
      const d = Number(a.d);
      const text = decodeEntities(stripMarkup(m[2] || ''));
      cues.push({ start: t / 1000, end: isFinite(d) && d > 0 ? (t + d) / 1000 : NaN, text });
    }
    return cues;
  }

  /** srv1: <transcript><text start="s" dur="s">..</text>; srv2: <timedtext><text t="ms" d="ms">..</text>. */
  function parseTextElements(body) {
    const s = String(body);
    const cues = [];
    const re = /<text\b([^>]*?)(?:\/>|>([\s\S]*?)<\/text\s*>)/g;
    let m;
    while ((m = re.exec(s))) {
      const a = parseAttrs(m[1]);
      let start;
      let end;
      if (a.start !== undefined) {
        start = Number(a.start);
        end = start + Number(a.dur);
      } else {
        start = Number(a.t) / 1000;
        end = start + Number(a.d) / 1000;
      }
      if (!isFinite(start)) continue;
      // srv1 text is HTML that was XML-escaped once more (e.g. "&amp;#39;"): decode twice.
      const text = decodeEntities(decodeEntities(stripMarkup(m[2] || '')));
      cues.push({ start, end: isFinite(end) && end > start ? end : NaN, text });
    }
    return cues;
  }

  /** TTML time expression -> seconds. */
  function ttmlTime(value, rates) {
    const v = String(value || '').trim();
    if (!v) return NaN;
    let m = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(v);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number('0.' + m[4]) : 0);
    m = /^(\d+):(\d{2}):(\d{2}):(\d+(?:\.\d+)?)$/.exec(v); // frames
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / rates.frameRate;
    m = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/.exec(v);
    if (m) {
      const n = Number(m[1]);
      switch (m[2]) {
        case 'h':
          return n * 3600;
        case 'm':
          return n * 60;
        case 's':
          return n;
        case 'ms':
          return n / 1000;
        case 'f':
          return n / rates.frameRate;
        default:
          return n / rates.tickRate;
      }
    }
    return NaN;
  }

  /** TTML/DFXP: <tt><body><div><p begin end|dur>text<br/>text</p></div></body></tt> */
  function parseTtml(body) {
    const s = String(body);
    const ttTag = /<(?:\w+:)?tt\b([^>]*)>/.exec(s);
    const ttAttrs = parseAttrs(ttTag ? ttTag[1] : '');
    const rate = (name, def) => {
      const key = Object.keys(ttAttrs).find((k) => k === name || k.endsWith(':' + name));
      const n = key ? Number(ttAttrs[key]) : NaN;
      return n > 0 ? n : def;
    };
    const rates = { frameRate: rate('frameRate', 30), tickRate: rate('tickRate', 1) };
    const bodyStart = s.search(/<(?:\w+:)?body\b/);
    const src = bodyStart >= 0 ? s.slice(bodyStart) : s;
    const cues = [];
    const re = /<(?:\w+:)?p\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?p\s*>)/g;
    let m;
    while ((m = re.exec(src))) {
      const a = parseAttrs(m[1]);
      const start = ttmlTime(a.begin, rates);
      if (!isFinite(start)) continue;
      let end = ttmlTime(a.end, rates);
      if (!isFinite(end) && a.dur) end = start + ttmlTime(a.dur, rates);
      // XML whitespace handling: source newlines/indentation are spaces, <br/> is the line break.
      const inner = String(m[2] || '').replace(/[\r\n\t]+/g, ' ');
      const text = decodeEntities(stripMarkup(inner.replace(/<(?:\w+:)?br\s*\/?>/gi, '\n')));
      cues.push({ start, end: isFinite(end) ? end : NaN, text });
    }
    return cues;
  }

  /**
   * Guesses the caption format of a response body.
   * @returns {'json3'|'vtt'|'srv3'|'srv2'|'srv1'|'ttml'|'srt'|null}
   */
  function detect(body) {
    if (body && typeof body === 'object' && Array.isArray(body.events)) return 'json3';
    const s = String(body == null ? '' : body).replace(/^﻿/, '').replace(/^\s+/, '').slice(0, 4096);
    if (!s) return null;
    if (/^WEBVTT/.test(s)) return 'vtt';
    if (s[0] === '{') return 'json3';
    if (/<timedtext\b[^>]*\bformat\s*=\s*["']3["']/.test(s)) return 'srv3';
    if (/<(?:\w+:)?tt\b/.test(s)) return 'ttml';
    if (/<transcript\b/.test(s)) return 'srv1';
    if (/<timedtext\b/.test(s)) return 'srv2';
    if (/^\d+[ \t]*\r?\n[ \t]*(?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3}[ \t]*-->/.test(s)) return 'srt';
    if (TIMING_RE.test(s.split(/\r?\n/)[0])) return 'srt';
    return null;
  }

  const PARSERS = {
    json3: parseJson3,
    vtt: (b) => parseTimedBlocks(b, true),
    srt: (b) => parseTimedBlocks(b, false),
    srv3: parseSrv3,
    srv2: parseTextElements,
    srv1: parseTextElements,
    ttml: parseTtml,
  };

  /**
   * Parses a caption body into clean cues.
   * @param {string|object} body  response text (or an already parsed json3 object)
   * @param {string} [fmt]        declared format (json3|vtt|srv1|srv2|srv3|ttml|srt|'auto'); the body is sniffed first
   * @returns {{start:number,end:number,text:string}[]} cues in seconds, sorted, non-overlapping
   */
  function parse(body, fmt) {
    if (body == null || body === '') return [];
    const declared = normFormat(fmt);
    const f = detect(body) || (declared && declared !== 'auto' ? declared : null);
    if (!f || !PARSERS[f]) throw makeError('format', 'Unknown subtitle format' + (fmt ? ': ' + fmt : ''));
    return normalize(PARSERS[f](body));
  }

  /* ------------------------------------------------------------------ writers */

  function safeLang(lang) {
    const l = String(lang || '').trim();
    return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(l) ? l : '';
  }

  /** SubRip. */
  function toSrt(cues) {
    return normalize(cues)
      .map((c, i) => i + 1 + '\n' + formatTime(c.start, ',') + ' --> ' + formatTime(c.end, ',') + '\n' + c.text.replace(/-->/g, '->') + '\n')
      .join('\n');
  }

  function escapeVtt(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** WebVTT (same header lines as YouTube's own files). */
  function toVtt(cues, lang) {
    const l = safeLang(lang);
    const head = 'WEBVTT\nKind: captions\n' + (l ? 'Language: ' + l + '\n' : '') + '\n';
    return head + normalize(cues).map((c) => formatTime(c.start, '.') + ' --> ' + formatTime(c.end, '.') + '\n' + escapeVtt(c.text) + '\n').join('\n');
  }

  /** TTML 1 (W3C Timed Text), one <p> per cue, <br/> between lines. */
  function toTtml(cues, lang) {
    const l = safeLang(lang) || 'und';
    const ps = normalize(cues)
      .map((c) => '      <p begin="' + formatTime(c.start, '.') + '" end="' + formatTime(c.end, '.') + '">' + c.text.split('\n').map(escapeXml).join('<br/>') + '</p>')
      .join('\n');
    return (
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:timeBase="media" xml:lang="' +
      escapeXml(l) +
      '">\n' +
      '  <head>\n' +
      '    <styling>\n' +
      '      <style xml:id="s1" tts:textAlign="center" tts:fontFamily="proportionalSansSerif" tts:fontSize="100%" tts:color="white"/>\n' +
      '    </styling>\n' +
      '    <layout>\n' +
      '      <region xml:id="r1" tts:origin="10% 75%" tts:extent="80% 20%" tts:displayAlign="after"/>\n' +
      '    </layout>\n' +
      '  </head>\n' +
      '  <body region="r1" style="s1">\n' +
      '    <div>\n' +
      ps +
      (ps ? '\n' : '') +
      '    </div>\n' +
      '  </body>\n' +
      '</tt>\n'
    );
  }

  /** YouTube srv3 ("timedtext format 3"), times in milliseconds. */
  function toSrv3(cues) {
    const ps = normalize(cues)
      .map((c) => {
        const t = toMs(c.start);
        return '<p t="' + t + '" d="' + Math.max(1, toMs(c.end) - t) + '">' + escapeXml(c.text) + '</p>';
      })
      .join('\n');
    return '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">\n<body>\n' + ps + (ps ? '\n' : '') + '</body>\n</timedtext>\n';
  }

  /** Minimal YouTube json3. */
  function toJson3(cues) {
    const events = normalize(cues).map((c) => {
      const t = toMs(c.start);
      return { tStartMs: t, dDurationMs: Math.max(1, toMs(c.end) - t), segs: [{ utf8: c.text }] };
    });
    return JSON.stringify({ wireMagic: 'pb3', events }, null, 1) + '\n';
  }

  /** A caption line that starts a new speaker/sound description stays on its own transcript line. */
  const OWN_LINE = /^(?:[-–—]|>>|\[|\()/;

  /**
   * Plain transcript: one line per caption (the lines of a multi-line caption are joined with spaces,
   * except dialogue lines starting with "-", ">>", "[" or "("). Lines a caption repeats from the text
   * before it (consecutive duplicates, rolling captions) are written once.
   */
  function toTxt(cues) {
    const out = [];
    const push = (line) => {
      if (out[out.length - 1] !== line) out.push(line); // never two identical lines in a row
    };
    let recent = []; // tail of the caption lines already written
    for (const c of normalize(cues)) {
      const lines = splitLines(c.text);
      const fresh = lines.slice(overlapLines(recent.slice(-lines.length), lines));
      if (!fresh.length) continue;
      recent = recent.concat(fresh).slice(-16);
      let current = '';
      for (const line of fresh) {
        if (current && OWN_LINE.test(line)) {
          push(current);
          current = line;
        } else current = current ? current + ' ' + line : line;
      }
      if (current) push(current);
    }
    return out.length ? out.join('\n') + '\n' : '';
  }

  const WRITERS = {
    srt: (cues) => toSrt(cues),
    vtt: (cues, lang) => toVtt(cues, lang),
    ttml: (cues, lang) => toTtml(cues, lang),
    srv3: (cues) => toSrv3(cues),
    json3: (cues) => toJson3(cues),
    txt: (cues) => toTxt(cues),
  };

  /** MIME type to use with chrome.downloads for a subtitle extension (Chrome renames on mismatch). */
  function mimeFor(ext) {
    const map = AYT.DOWNLOAD_MIME || FALLBACK_MIME;
    return map[ext] || FALLBACK_MIME[ext] || 'application/octet-stream';
  }

  /**
   * The /api/timedtext format to request for a wanted output format: vtt/ttml/srv3/json3 natively,
   * SRT and TXT are built from json3.
   */
  function sourceFormat(target) {
    const f = normFormat(target);
    return f === 'vtt' || f === 'ttml' || f === 'srv3' || f === 'json3' ? f : 'json3';
  }

  /**
   * Converts a caption body to another format.
   * Native passthrough when the body already is the wanted vtt/ttml/srv3/json3 (still checked for cues);
   * SRT and TXT are always rebuilt (YouTube's own SRT has duplicated cues and zero-width spaces).
   * @param {string|object} body
   * @param {string} fmtIn   declared input format (the body is sniffed first)
   * @param {string} fmtOut  srt | vtt | ttml | srv3 | txt | json3
   * @param {{lang?: string, normalize?: boolean}} [opts]  lang = language code written into VTT/TTML;
   *                                                       normalize = rebuild even when a passthrough is possible
   * @returns {{text: string, mime: string, ext: string, cues: number}}
   */
  function convert(body, fmtIn, fmtOut, opts) {
    const o = opts || {};
    const out = normFormat(fmtOut);
    if (!WRITERS[out]) throw makeError('format', 'Unsupported subtitle format: ' + fmtOut);
    const cues = parse(body, fmtIn);
    if (!cues.length) throw makeError('empty', 'The subtitle track is empty');
    const src = detect(body) || normFormat(fmtIn);
    const passthrough = !o.normalize && src === out && typeof body === 'string' && (out === 'vtt' || out === 'ttml' || out === 'srv3' || out === 'json3');
    const text = passthrough ? body : WRITERS[out](cues, o.lang);
    return { text, mime: mimeFor(out), ext: out, cues: cues.length };
  }

  AYT.subtitles = {
    FORMATS,
    NATIVE,
    detect,
    parse,
    normalize,
    toSrt,
    toVtt,
    toTtml,
    toSrv3,
    toJson3,
    toTxt,
    convert,
    mimeFor,
    sourceFormat,
    formatTime,
    parseClock,
    decodeEntities,
    escapeXml,
    cleanText,
  };
})(globalThis);
