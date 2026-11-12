#!/usr/bin/env node
/*
 * Unit tests for content/toolbar.js:
 *   - aria-pressed only on action toggles whose name does not change (ariaPressed: false)
 *   - the badge is part of the button's accessible name, the progress ring is its aria-description; both are written
 *     only when the spoken text changes (whole percent)
 *   - refreshes (download progress) never measure the layout; an open panel follows its button on window resizes,
 *     re-rendered buttons and resize-observer notifications only
 *   - the layout observer watches the toolbar's column (#below), where YouTube fills its slots above the toolbar
 *     late: a size change of the column alone moves the panel, also after the toolbar was re-mounted into it
 * Run: node --test tools/tests/toolbar.test.mjs
 *
 * toolbar.js (with the real shared/dom.js, i18n and utils) runs in a vm context on a small fake DOM. Layout is
 * faked: buttons sit 44 px apart inside the toolbar (offsetParent), whose rect the tests move.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = path.join(ROOT, 'extension');

/* ------------------------------------------------------------------ fake DOM */
function fakeDom() {
  const writes = []; // { el, name, value } for attribute, style and text writes
  let doc = null;

  class Node {
    constructor() {
      this.parentNode = null;
      this.childNodes = [];
      this.listeners = {};
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get children() {
      return this.childNodes.filter((c) => c instanceof Element);
    }
    get nextSibling() {
      if (!this.parentNode) return null;
      const s = this.parentNode.childNodes;
      return s[s.indexOf(this) + 1] || null;
    }
    get isConnected() {
      for (let n = this; n; n = n.parentNode || n.host) if (n === doc) return true;
      return false;
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = [];
      if (v != null && v !== '') this.appendChild(new Text(String(v)));
      writes.push({ el: this, name: 'textContent', value: String(v) });
    }
    appendChild(c) {
      return this.insertBefore(c, null);
    }
    append(...cs) {
      for (const c of cs) this.appendChild(c instanceof Node ? c : new Text(String(c)));
    }
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(c);
      else this.childNodes.splice(i, 0, c);
      c.parentNode = this;
      return c;
    }
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      c.parentNode = null;
      return c;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    contains(n) {
      for (; n; n = n.parentNode) if (n === this) return true;
      return false;
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c instanceof Element && c.matches(sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
  }

  class Text extends Node {
    constructor(data) {
      super();
      this.data = data;
    }
    get textContent() {
      return this.data;
    }
    set textContent(v) {
      this.data = String(v);
    }
  }

  function makeStyle(el) {
    const props = new Map();
    const api = {
      setProperty(k, v) {
        props.set(k, String(v));
        writes.push({ el, name: k, value: String(v) });
      },
      getPropertyValue: (k) => (props.has(k) ? props.get(k) : ''),
      removeProperty: (k) => props.delete(k),
    };
    return new Proxy(api, {
      get: (t, k) => (k in t ? t[k] : props.has(k) ? props.get(k) : ''),
      set(t, k, v) {
        props.set(k, String(v));
        writes.push({ el, name: k, value: String(v) });
        return true;
      },
    });
  }

  class ShadowRoot extends Node {
    constructor(host) {
      super();
      this.host = host;
      this.activeElement = null;
    }
  }

  class Element extends Node {
    constructor(tag) {
      super();
      this.tagName = String(tag).toUpperCase();
      this.attributes = new Map();
      this.classes = new Set();
      this.dataset = {};
      this.style = makeStyle(this);
      this.id = '';
      this.tabIndex = -1;
      this.shadowRoot = null;
      this.rect = null; // fake viewport rect (left, top)
      this.rectCalls = 0;
      const self = this;
      this.classList = {
        add: (...c) => c.forEach((x) => self.classes.add(x)),
        remove: (...c) => c.forEach((x) => self.classes.delete(x)),
        contains: (c) => self.classes.has(c),
        toggle(c, force) {
          const on = force === undefined ? !self.classes.has(c) : !!force;
          if (on) self.classes.add(c);
          else self.classes.delete(c);
          return on;
        },
      };
    }
    get className() {
      return Array.from(this.classes).join(' ');
    }
    set className(v) {
      this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
    }
    setAttribute(name, value) {
      const v = String(value);
      this.attributes.set(name, v);
      if (name === 'class') this.className = v;
      writes.push({ el: this, name, value: v });
    }
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    hasAttribute(name) {
      return this.attributes.has(name);
    }
    removeAttribute(name) {
      if (this.attributes.delete(name)) writes.push({ el: this, name, value: null });
    }
    /** '.a', '.a.b', '#id', 'tag' or '[attr]', comma-separated */
    matches(sel) {
      return sel.split(',').some((part) => {
        const s = part.trim();
        if (s.startsWith('[')) return this.attributes.has(s.slice(1, -1));
        if (s.startsWith('.')) return s.slice(1).split('.').every((c) => this.classes.has(c));
        if (s.startsWith('#')) return this.id === s.slice(1);
        return this.tagName === s.toUpperCase();
      });
    }
    closest(sel) {
      for (let n = this; n instanceof Element; n = n.parentNode) if (n.matches(sel)) return n;
      return null;
    }
    attachShadow(init) {
      const root = new ShadowRoot(this);
      if (init && init.mode === 'open') this.shadowRoot = root;
      return root;
    }
    focus() {}
    getClientRects() {
      return [];
    }
    getBoundingClientRect() {
      this.rectCalls++;
      const r = Object.assign({ left: 0, top: 0, width: 0, height: 0 }, this.rect || {});
      if (this.classes.has('ayt-panel')) r.width = 0.98 * this.offsetWidth; // mid pop-in animation (scale .98)
      return Object.assign(r, { right: r.left + r.width, bottom: r.top + r.height });
    }
    // fake layout: toolbar children 44 px apart, 40 px buttons, panels 440 px wide
    get offsetParent() {
      return this.parentNode instanceof Element && this.parentNode.classes.has('ayt-toolbar') ? this.parentNode : null;
    }
    get offsetLeft() {
      return this.parentNode instanceof Node ? 10 + 44 * this.parentNode.children.indexOf(this) : 0;
    }
    get offsetTop() {
      return 6;
    }
    get offsetHeight() {
      return 40;
    }
    get offsetWidth() {
      return this.classes.has('ayt-panel') ? 440 : 40;
    }
    get clientLeft() {
      return 0;
    }
    get clientTop() {
      return 0;
    }
  }

  doc = new Node();
  doc.visibilityState = 'visible';
  doc.documentElement = new Element('html');
  doc.documentElement.clientWidth = 1600;
  doc.appendChild(doc.documentElement);
  doc.body = new Element('body');
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;
  doc.createElement = (tag) => new Element(tag);
  doc.createElementNS = (ns, tag) => new Element(tag);
  doc.createTextNode = (s) => new Text(s);
  // the watch page's primary column: #player (holds #movie_player), then the toolbar's column #below, where YouTube's
  // info-panel slot #clarify-box comes before <ytd-watch-metadata><div id="above-the-fold"> (the first anchor)
  const add = (parent, tag, id) => {
    const el = new Element(tag);
    el.id = id;
    return parent.appendChild(el);
  };
  const primaryInner = add(doc.body, 'div', 'primary-inner');
  const playerBox = add(primaryInner, 'div', 'player');
  const player = add(playerBox, 'div', 'movie_player');
  const below = add(primaryInner, 'div', 'below');
  add(below, 'div', 'clarify-box');
  const aboveFold = add(add(below, 'ytd-watch-metadata', ''), 'div', 'above-the-fold');
  // the toolbar's anchors: the first one, else the last one (right under the player) while #below is not in the page
  doc.querySelector = (sel) => {
    const el = /watch-active-metadata > #above-the-fold$/.test(sel) ? aboveFold : /#primary-inner > #player$/.test(sel) ? playerBox : null;
    return el && el.isConnected ? el : null;
  };

  /** Writes to `root` or its descendants from now on: call the returned function to read them. */
  const writesTo = (root) => {
    const mark = writes.length;
    return () => writes.slice(mark).filter((w) => root.contains(w.el)).map((w) => ({ name: w.name, value: w.value }));
  };
  return { Node, Element, doc, player, below, primaryInner, writesTo };
}

/* ------------------------------------------------------------------ sandbox */
function load(sandbox, rel) {
  const file = path.join(EXT, rel);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
}

function setup() {
  const dom = fakeDom();
  const winListeners = {};
  const rafs = new Map();
  let rafSeq = 0;
  const intervals = new Map();
  let intervalSeq = 0;
  const observers = [];
  class ResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.targets = new Set();
      this.connected = true;
      observers.push(this);
    }
    observe(el) {
      this.targets.add(el);
    }
    unobserve(el) {
      this.targets.delete(el);
    }
    disconnect() {
      this.targets.clear();
      this.connected = false;
    }
    fire() {
      if (this.connected && this.targets.size) this.cb(Array.from(this.targets, (target) => ({ target })), this);
    }
  }
  const sandbox = {
    console,
    document: dom.doc,
    Node: dom.Node,
    Element: dom.Element,
    location: { reload() {} },
    scrollX: 0,
    scrollY: 0,
    innerHeight: 1000,
    scrollTo() {},
    getComputedStyle: () => ({ direction: 'ltr', visibility: 'visible' }),
    ResizeObserver,
    requestAnimationFrame(fn) {
      rafs.set(++rafSeq, fn);
      return rafSeq;
    },
    cancelAnimationFrame: (id) => rafs.delete(id),
    // the toolbar's mount re-check (every 800 ms in the page) runs only when a test calls env.mountCheck()
    setInterval(fn) {
      intervals.set(++intervalSeq, fn);
      return intervalSeq;
    },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn, ms) => {
      const h = setTimeout(fn, ms);
      if (h && h.unref) h.unref();
      return h;
    },
    clearTimeout,
    addEventListener(type, fn) {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ['shared/constants.js', 'shared/utils.js', 'shared/i18n.js', 'shared/i18n/en.js', 'shared/dom.js']) load(sandbox, f);
  const AYT = sandbox.AYT;
  const { h } = AYT.dom;
  AYT.i18n.setLanguage('en');
  Object.assign(AYT, {
    ui: {
      mountStyles() {},
      applyTheme() {},
      notice: () => h('div'),
      button: (o) => h('button', { on: { click: o.onClick } }),
      toast() {},
      showError() {},
    },
    keys: { isolate() {}, guard() {}, trusted: () => true },
    page: { type: 'watch', videoId: 'dQw4w9WgXcQ', info: { type: 'watch', videoId: 'dQw4w9WgXcQ' }, onChange() {} },
    settings: { get: () => [], onChange() {} },
    client: { on() {} },
    player: { root: () => dom.player },
    videoInfo: { get: async () => ({}) },
  });
  load(sandbox, 'content/toolbar.js');

  const shadowOf = (id) => {
    const hostEl = dom.doc.querySelectorAll('div').find((el) => el.id === id);
    return hostEl && hostEl.shadowRoot;
  };
  const env = {
    AYT,
    h,
    writesTo: dom.writesTo,
    bar: () => shadowOf('ayt-toolbar-host').querySelector('.ayt-toolbar'),
    button: (id) => shadowOf('ayt-toolbar-host').querySelectorAll('.ayt-tb-btn').find((b) => b.dataset.id === id) || null,
    panel: () => shadowOf('ayt-portal-host').querySelector('.ayt-panel'),
    below: dom.below,
    primaryInner: dom.primaryInner,
    /** The open panel's layout observer (it watches the toolbar host). */
    layoutObserver: () => observers.find((o) => o.targets.has(AYT.toolbar.host)),
    /** The browser reports a size change of `el` alone: only the observers that watch `el` are called. */
    resized: (el) => observers.filter((o) => o.connected && o.targets.has(el)).forEach((o) => o.cb([{ target: el }], o)),
    mountCheck: () => Array.from(intervals.values()).forEach((fn) => fn()),
    fireWindow: (type) => (winListeners[type] || []).forEach((fn) => fn({ type })),
    flushRaf() {
      const fns = Array.from(rafs.values());
      rafs.clear();
      fns.forEach((fn) => fn(0));
    },
  };
  return env;
}

/* ------------------------------------------------------------------ tests */
test('toolbar: ariaPressed:false toggles get no aria-pressed; other action toggles do; panels never', () => {
  const env = setup();
  const { AYT, h } = env;
  let comments = false;
  let cinema = false;
  AYT.toolbar.register({ id: 'comments', group: 'end', icon: 'x', title: () => (comments ? 'Show comments' : 'Hide comments'), isOn: () => comments, ariaPressed: false, onClick() {} });
  AYT.toolbar.register({ id: 'cinema', group: 'tools', icon: 'x', title: () => 'Cinema mode', isOn: () => cinema, onClick() {} });
  AYT.toolbar.register({ id: 'speed', group: 'tools', icon: 'x', title: () => 'Playback speed', isOn: () => true, panel: { render: () => h('div') } });
  AYT.toolbar.start();

  const c = env.button('comments');
  assert.equal(c.getAttribute('aria-pressed'), null);
  assert.equal(c.getAttribute('aria-label'), 'Hide comments');
  comments = true;
  AYT.toolbar.refresh();
  assert.equal(c.getAttribute('aria-pressed'), null, 'the name says it: "Show comments", not "pressed"');
  assert.equal(c.getAttribute('aria-label'), 'Show comments');
  assert.ok(c.classList.contains('is-on'), 'the visual highlight stays');

  const m = env.button('cinema');
  assert.equal(m.getAttribute('aria-pressed'), 'false');
  cinema = true;
  AYT.toolbar.refresh();
  assert.equal(m.getAttribute('aria-pressed'), 'true');

  const s = env.button('speed');
  assert.equal(s.getAttribute('aria-pressed'), null);
  assert.equal(s.getAttribute('aria-expanded'), 'false');
});

test('toolbar: the badge joins the accessible name, the ring is described; written only when the text changes', () => {
  const env = setup();
  const { AYT, h } = env;
  const st = { badge: null, progress: null, rate: null };
  AYT.toolbar.register({ id: 'video', group: 'download', order: 10, icon: 'video', title: () => 'Download video', panel: { render: () => h('div') }, badge: () => st.badge, progress: () => st.progress });
  AYT.toolbar.register({ id: 'speed', group: 'tools', order: 20, icon: 'speed', title: () => 'Playback speed', panel: { render: () => h('div') }, badge: () => st.rate });
  AYT.toolbar.register({ id: 'loop', group: 'tools', order: 30, icon: 'loop', title: () => 'Loop', onClick() {}, badge: () => 3, badgeLabel: (v) => `${v} rounds left` });
  AYT.toolbar.start();

  const v = env.button('video');
  const ring = () => v.querySelector('.ayt-tb-btn__ring');
  const dot = () => v.querySelector('.ayt-tb-btn__dot');
  assert.equal(v.getAttribute('aria-label'), 'Download video');
  assert.equal(v.hasAttribute('aria-description'), false);
  assert.equal(ring(), null);
  assert.equal(dot(), null);

  st.badge = 2;
  st.progress = 45.4;
  AYT.toolbar.refresh();
  assert.equal(v.getAttribute('aria-label'), 'Download video, 2 active downloads');
  assert.equal(v.getAttribute('aria-description'), 'Progress: 45%');
  assert.equal(ring().style.getPropertyValue('--p'), '45');
  assert.equal(dot().textContent, '2');

  // progress pushes inside the same whole percent touch nothing
  let since = env.writesTo(v);
  st.progress = 45.9;
  AYT.toolbar.refresh();
  AYT.toolbar.refresh();
  assert.deepEqual(since(), []);
  st.progress = 46.2;
  AYT.toolbar.refresh();
  assert.equal(v.getAttribute('aria-description'), 'Progress: 46%');
  assert.deepEqual(since().map((w) => w.name).sort(), ['--p', 'aria-description']);

  since = env.writesTo(v);
  st.badge = 1;
  AYT.toolbar.refresh();
  assert.equal(v.getAttribute('aria-label'), 'Download video, 1 active download', 'plural form');
  assert.deepEqual(since().map((w) => w.name).sort(), ['aria-label', 'textContent']);

  st.progress = 0; // queued: a small ring
  AYT.toolbar.refresh();
  assert.equal(v.getAttribute('aria-description'), 'Progress: 0%');
  assert.equal(ring().style.getPropertyValue('--p'), '2');
  st.progress = 140;
  AYT.toolbar.refresh();
  assert.equal(v.getAttribute('aria-description'), 'Progress: 100%');

  st.badge = null;
  st.progress = null;
  AYT.toolbar.refresh();
  assert.equal(v.getAttribute('aria-label'), 'Download video');
  assert.equal(v.hasAttribute('aria-description'), false);
  assert.equal(ring(), null);
  assert.equal(dot(), null);

  // other buttons: the badge text itself (a tool formats it in the UI language), or the def's own badgeLabel
  st.rate = '1.5';
  AYT.toolbar.refresh();
  assert.equal(env.button('speed').getAttribute('aria-label'), 'Playback speed, 1.5');
  assert.equal(env.button('loop').getAttribute('aria-label'), 'Loop, 3 rounds left');
});

test('toolbar: open(id) is a keyboard open; open(id, { viaKeyboard: false }) (popup link clicked) is a mouse open', () => {
  const env = setup();
  const { AYT, h } = env;
  const seen = [];
  AYT.toolbar.register({ id: 'video', group: 'download', order: 10, icon: 'video', title: () => 'Download video', panel: { selfFit: true, render: (ctx) => (seen.push(ctx.viaKeyboard), h('div')) } });
  AYT.toolbar.start();
  AYT.toolbar.open('video', { viaKeyboard: false });
  assert.ok(AYT.toolbar.isOpen('video'));
  AYT.toolbar.close();
  AYT.toolbar.open('video');
  AYT.toolbar.close();
  AYT.toolbar.open('video', { viaKeyboard: true });
  assert.deepEqual(seen, [false, true, true]);
});

test('toolbar: refreshes never measure the layout; an open panel follows its button when the layout changed', () => {
  const env = setup();
  const { AYT, h } = env;
  let pct = 10;
  AYT.toolbar.register({ id: 'video', group: 'download', order: 10, icon: 'video', title: () => 'Download video', panel: { selfFit: true, render: () => h('div') }, progress: () => pct });
  AYT.toolbar.register({ id: 'speed', group: 'tools', order: 20, icon: 'speed', title: () => 'Playback speed', panel: { selfFit: true, render: () => h('div') } });
  AYT.toolbar.start();
  const bar = env.bar();
  bar.rect = { left: 100, top: 500 };
  const speedLeft = () => env.button('speed').offsetLeft;

  AYT.toolbar.open('speed');
  const panel = env.panel();
  assert.ok(panel, 'panel open');
  assert.equal(panel.style.left, 100 + speedLeft() - 8 + 'px', 'under its button (layout box, not the scaled rect)');
  assert.equal(panel.style.top, 500 + 6 + 40 + 8 + 'px');
  env.flushRaf();
  const measured = bar.rectCalls;

  // a download in progress: many refreshes, no layout reads, no position writes
  let since = env.writesTo(panel);
  for (let i = 0; i < 20; i++) {
    pct += 1.5;
    AYT.toolbar.refresh();
  }
  env.flushRaf();
  assert.equal(bar.rectCalls, measured, 'refresh() does not measure');
  assert.deepEqual(since().filter((w) => w.name === 'left' || w.name === 'top'), []);

  // theater mode: the player grows and the toolbar moves down; the layout observer follows it
  const ro = env.layoutObserver();
  assert.ok(ro && ro.targets.has(AYT.toolbar.host), 'observes the toolbar');
  assert.ok(Array.from(ro.targets).some((el) => el.id === 'movie_player'), 'observes the player');
  bar.rect = { left: 100, top: 900 };
  ro.fire();
  assert.equal(panel.style.top, 900 + 6 + 40 + 8 + 'px');
  // a notification that moved nothing writes nothing
  since = env.writesTo(panel);
  ro.fire();
  assert.deepEqual(since(), []);
  // near the right edge the panel is clamped by its layout width (440), not by its animated, scaled rect
  bar.rect = { left: 1400, top: 900 };
  ro.fire();
  assert.equal(panel.style.left, 1600 - 440 - 12 + 'px');
  bar.rect = { left: 100, top: 900 };
  ro.fire();

  // window resizes: measured once, in the next frame
  const before = bar.rectCalls;
  env.fireWindow('resize');
  env.fireWindow('resize');
  env.fireWindow('resize');
  assert.equal(bar.rectCalls, before, 'not synchronously');
  env.flushRaf();
  assert.equal(bar.rectCalls, before + 1);

  // re-rendered buttons (a new button before this one) move the panel along, in the next frame
  const oldLeft = panel.style.left;
  AYT.toolbar.register({ id: 'loop', group: 'tools', order: 5, icon: 'loop', title: () => 'Loop', onClick() {} });
  assert.equal(panel.style.left, oldLeft);
  env.flushRaf();
  assert.equal(panel.style.left, 100 + speedLeft() - 8 + 'px');
  assert.notEqual(panel.style.left, oldLeft);

  // closing stops observing and drops a pending re-position
  env.fireWindow('resize');
  const atClose = bar.rectCalls;
  AYT.toolbar.close();
  assert.equal(ro.connected, false);
  env.flushRaf();
  assert.equal(bar.rectCalls, atClose);
});

test('toolbar: an open panel follows content YouTube fills in above the toolbar (only the column #below changes size)', () => {
  const env = setup();
  const { AYT, h } = env;
  AYT.toolbar.register({ id: 'speed', group: 'tools', order: 20, icon: 'speed', title: () => 'Playback speed', panel: { selfFit: true, render: () => h('div') } });
  AYT.toolbar.start();
  const bar = env.bar();
  bar.rect = { left: 100, top: 500 };
  AYT.toolbar.open('speed');
  const panel = env.panel();
  assert.equal(panel.style.top, 500 + 6 + 40 + 8 + 'px');
  env.flushRaf();

  const ro = env.layoutObserver();
  assert.ok(ro.targets.has(env.below), 'observes the column that holds the toolbar');
  // An info panel fills #clarify-box seconds after a navigation: the toolbar moves down, but the toolbar host, the
  // player and <html> (0 px tall on YouTube) keep their size; only the column grows.
  bar.rect = { left: 100, top: 596 };
  env.resized(env.below);
  assert.equal(panel.style.top, 596 + 6 + 40 + 8 + 'px', 'the panel follows its button');
  // comments loading further down the column: the toolbar did not move, nothing is written
  const since = env.writesTo(panel);
  env.resized(env.below);
  assert.deepEqual(since(), []);
  // the next video has no info panel: YouTube empties the slot and the panel moves back up
  bar.rect = { left: 100, top: 500 };
  env.resized(env.below);
  assert.equal(panel.style.top, 500 + 6 + 40 + 8 + 'px');
});

test('toolbar: re-mounted from under the player into #below while a panel is open, the panel follows that column', () => {
  const env = setup();
  const { AYT, h } = env;
  env.below.remove(); // the column is not rendered yet: the toolbar goes right under the player (last anchor)
  AYT.toolbar.register({ id: 'speed', group: 'tools', order: 20, icon: 'speed', title: () => 'Playback speed', panel: { selfFit: true, render: () => h('div') } });
  AYT.toolbar.start();
  assert.equal(AYT.toolbar.host.parentNode, env.primaryInner);
  const bar = env.bar();
  bar.rect = { left: 100, top: 500 };
  AYT.toolbar.open('speed');
  const panel = env.panel();
  env.flushRaf();
  const first = env.layoutObserver();
  assert.ok(first && !first.targets.has(env.below));

  // the column appears and the next mount check moves the toolbar into it, above the title
  env.primaryInner.appendChild(env.below);
  bar.rect = { left: 100, top: 620 };
  env.mountCheck();
  assert.ok(env.below.contains(AYT.toolbar.host), 'moved into the column');
  env.flushRaf();
  assert.equal(panel.style.top, 620 + 6 + 40 + 8 + 'px', 'the panel follows the moved toolbar');
  const ro = env.layoutObserver();
  assert.equal(first.connected, false, 'the old observer is dropped');
  assert.ok(ro && ro !== first && ro.targets.has(env.below), 'the new column is observed');
  bar.rect = { left: 100, top: 716 };
  env.resized(env.below);
  assert.equal(panel.style.top, 716 + 6 + 40 + 8 + 'px');

  // a mount check that moves nothing keeps the observer
  env.mountCheck();
  assert.equal(env.layoutObserver(), ro);
  AYT.toolbar.close();
  assert.equal(ro.connected, false);
});
