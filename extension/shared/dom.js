/*
 * Akif's Special YouTube Addon — DOM helpers + SVG icon set.
 * Never uses innerHTML (YouTube enforces Trusted Types); everything is built with createElement(NS).
 *
 *   const { h, icon } = AYT.dom;
 *   h('button', { class: 'ayt-btn', on: { click: fn }, title: 'Hi' }, icon('download'), 'Download')
 *
 * Props: class/className (string or array), style (string or object), dataset (object),
 *        attrs (object of raw attributes), on (object of listeners), text (textContent),
 *        any other key: set as property when it exists on the element, otherwise as attribute.
 *        ref: function(el) called after creation.
 * Children: strings, numbers, Nodes, arrays (flattened), null/undefined/false (skipped).
 */
(function (g) {
  'use strict';
  const AYT = (g.AYT = g.AYT || {});
  if (AYT.dom) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BOOL_PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'open', 'multiple', 'readOnly', 'required']);

  function appendChildren(el, children) {
    for (const c of children) {
      if (c == null || c === false || c === true) continue;
      if (Array.isArray(c)) appendChildren(el, c);
      else if (c instanceof g.Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
  }

  function applyProps(el, props, isSvg) {
    if (!props) return;
    for (const [key, value] of Object.entries(props)) {
      if (value == null) continue;
      // `false` means "leave unset" except for boolean DOM properties and aria-* attributes.
      if (value === false && !BOOL_PROPS.has(key) && !key.startsWith('aria-')) continue;
      switch (key) {
        case 'class':
        case 'className': {
          const cls = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
          if (isSvg) el.setAttribute('class', cls);
          else el.className = cls;
          break;
        }
        case 'style':
          if (typeof value === 'string') el.style.cssText = value;
          else for (const [k, v] of Object.entries(value)) {
            if (v == null) continue;
            if (k.startsWith('--')) el.style.setProperty(k, String(v));
            else el.style[k] = v;
          }
          break;
        case 'dataset':
          for (const [k, v] of Object.entries(value)) if (v != null) el.dataset[k] = String(v);
          break;
        case 'attrs':
          for (const [k, v] of Object.entries(value)) if (v != null && v !== false) el.setAttribute(k, v === true ? '' : String(v));
          break;
        case 'on':
          for (const [evt, fn] of Object.entries(value)) if (typeof fn === 'function') el.addEventListener(evt, fn);
          break;
        case 'text':
          el.textContent = String(value);
          break;
        case 'ref':
          break;
        default:
          if (isSvg) el.setAttribute(key, String(value));
          else if (key in el && !key.startsWith('aria') && key !== 'role' && key !== 'for') {
            try {
              el[key] = value;
            } catch (_) {
              el.setAttribute(key, String(value));
            }
          } else el.setAttribute(key === 'for' ? 'for' : key, value === true ? '' : String(value));
      }
    }
  }

  function h(tag, props, ...children) {
    if (props instanceof g.Node || Array.isArray(props) || typeof props === 'string' || typeof props === 'number') {
      children.unshift(props);
      props = null;
    }
    const el = document.createElement(tag);
    applyProps(el, props, false);
    appendChildren(el, children);
    if (props && typeof props.ref === 'function') props.ref(el);
    return el;
  }

  function s(tag, props, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    applyProps(el, props, true);
    for (const c of children) if (c) el.appendChild(c);
    return el;
  }

  /* ------------------------------------------------------------------ icons
   * 24x24 stroke icons (stroke = currentColor, width 2, round caps/joins).
   * Each icon: array of [tag, attrs]. attrs.fill = 'currentColor' makes a filled shape.
   */
  function gearPath(cx, cy, rOuter, rInner, teeth) {
    const pts = [];
    const step = (Math.PI * 2) / teeth;
    for (let i = 0; i < teeth; i++) {
      const a = i * step - Math.PI / 2;
      const w = step * 0.22;
      pts.push([a - step / 2 + w, rInner], [a - w * 0.9, rOuter], [a + w * 0.9, rOuter], [a + step / 2 - w, rInner]);
    }
    return (
      pts
        .map(([a, r], i) => (i ? 'L' : 'M') + (cx + Math.cos(a) * r).toFixed(2) + ' ' + (cy + Math.sin(a) * r).toFixed(2))
        .join(' ') + ' Z'
    );
  }

  const ICONS = {
    video: [['rect', { x: 2, y: 6, width: 14, height: 12, rx: 2.5 }], ['path', { d: 'M16 10.5 L21.5 7.2 V16.8 L16 13.5 Z', fill: 'currentColor' }]],
    music: [['path', { d: 'M9 18 V5.5 L20 3.5 V16' }], ['circle', { cx: 6.5, cy: 18, r: 2.5, fill: 'currentColor' }], ['circle', { cx: 17.5, cy: 16, r: 2.5, fill: 'currentColor' }]],
    image: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }], ['circle', { cx: 9, cy: 9.5, r: 1.8 }], ['path', { d: 'M21 15.5 L15.5 10 L5.5 20' }]],
    cc: [['rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 3 }], ['path', { d: 'M10.5 10.2 A2.2 2.2 0 1 0 10.5 13.8' }], ['path', { d: 'M17 10.2 A2.2 2.2 0 1 0 17 13.8' }]],
    camera: [['path', { d: 'M4 8 H7 L8.6 5.5 H15.4 L17 8 H20 A1.5 1.5 0 0 1 21.5 9.5 V18 A1.5 1.5 0 0 1 20 19.5 H4 A1.5 1.5 0 0 1 2.5 18 V9.5 A1.5 1.5 0 0 1 4 8 Z' }], ['circle', { cx: 12, cy: 13.5, r: 3.4 }]],
    loop: [['path', { d: 'M17 2.5 L20.5 6 L17 9.5' }], ['path', { d: 'M3.5 11.5 V10 A4 4 0 0 1 7.5 6 H20.5' }], ['path', { d: 'M7 21.5 L3.5 18 L7 14.5' }], ['path', { d: 'M20.5 12.5 V14 A4 4 0 0 1 16.5 18 H3.5' }]],
    speed: [['path', { d: 'M3.6 18 A9.4 9.4 0 1 1 20.4 18' }], ['path', { d: 'M12 14 L16.2 9' }], ['circle', { cx: 12, cy: 14, r: 1.4, fill: 'currentColor' }]],
    volume: [['path', { d: 'M11 5 L6.5 9 H3 V15 H6.5 L11 19 Z', fill: 'currentColor' }], ['path', { d: 'M15 9 A4 4 0 0 1 15 15' }], ['path', { d: 'M18 6.5 A8 8 0 0 1 18 17.5' }]],
    boost: [['path', { d: 'M10 5 L5.5 9 H2.5 V15 H5.5 L10 19 Z', fill: 'currentColor' }], ['path', { d: 'M13.5 9.5 A3.5 3.5 0 0 1 13.5 14.5' }], ['path', { d: 'M19.5 8.5 V15.5 M16 12 H23' }]],
    sliders: [['path', { d: 'M4 6 H10.5 M15.5 6 H20 M4 12 H6.5 M11.5 12 H20 M4 18 H13.5 M18.5 18 H20' }], ['circle', { cx: 13, cy: 6, r: 2.3 }], ['circle', { cx: 9, cy: 12, r: 2.3 }], ['circle', { cx: 16, cy: 18, r: 2.3 }]],
    pip: [['rect', { x: 2.5, y: 4.5, width: 19, height: 15, rx: 2.5 }], ['rect', { x: 12, y: 11.5, width: 7, height: 5.5, rx: 1, fill: 'currentColor', stroke: 'none' }]],
    moon: [['path', { d: 'M20.5 14.5 A8.5 8.5 0 1 1 9.5 3.5 A6.8 6.8 0 0 0 20.5 14.5 Z' }]],
    bulb: [['path', { d: 'M9 18 H15 M10 21.5 H14' }], ['path', { d: 'M12 2.5 A6.5 6.5 0 0 0 8.5 14.5 V16 H15.5 V14.5 A6.5 6.5 0 0 0 12 2.5 Z' }]],
    comments: [['path', { d: 'M5 4.5 H19 A2 2 0 0 1 21 6.5 V15 A2 2 0 0 1 19 17 H10.5 L5.5 20.5 V17 H5 A2 2 0 0 1 3 15 V6.5 A2 2 0 0 1 5 4.5 Z' }], ['path', { d: 'M7.5 9 H16.5 M7.5 12.5 H13' }]],
    'comments-off': [['path', { d: 'M8 4.5 H19 A2 2 0 0 1 21 6.5 V15 A2 2 0 0 1 20 16.7 M15 17 H10.5 L5.5 20.5 V17 H5 A2 2 0 0 1 3 15 V6.5 A2 2 0 0 1 3.6 5.1' }], ['path', { d: 'M2.5 2.5 L21.5 21.5' }]],
    settings: [['path', { d: gearPath(12, 12, 9.6, 7.2, 8) }], ['circle', { cx: 12, cy: 12, r: 2.9 }]],
    download: [['path', { d: 'M12 3.5 V15' }], ['path', { d: 'M7 10 L12 15 L17 10' }], ['path', { d: 'M4 16.5 V18.5 A2 2 0 0 0 6 20.5 H18 A2 2 0 0 0 20 18.5 V16.5' }]],
    check: [['path', { d: 'M4.5 12.5 L9.5 17.5 L19.5 6.5' }]],
    'check-circle': [['circle', { cx: 12, cy: 12, r: 9.5, fill: 'currentColor', stroke: 'none' }], ['path', { d: 'M7.5 12.3 L10.6 15.4 L16.6 9', stroke: '#fff' }]],
    x: [['path', { d: 'M6 6 L18 18 M18 6 L6 18' }]],
    copy: [['rect', { x: 8.5, y: 8.5, width: 12, height: 12, rx: 2 }], ['path', { d: 'M15.5 8.5 V6 A2 2 0 0 0 13.5 4 H6 A2 2 0 0 0 4 6 V13.5 A2 2 0 0 0 6 15.5 H8.5' }]],
    folder: [['path', { d: 'M3 7 A2 2 0 0 1 5 5 H9.5 L11.5 7.5 H19 A2 2 0 0 1 21 9.5 V17 A2 2 0 0 1 19 19 H5 A2 2 0 0 1 3 17 Z' }]],
    file: [['path', { d: 'M6 2.5 H14 L19 7.5 V20 A1.5 1.5 0 0 1 17.5 21.5 H6 A1.5 1.5 0 0 1 4.5 20 V4 A1.5 1.5 0 0 1 6 2.5 Z' }], ['path', { d: 'M14 2.5 V7.5 H19' }]],
    external: [['path', { d: 'M14 4 H20 V10 M20 4 L11 13' }], ['path', { d: 'M18 14 V19 A1 1 0 0 1 17 20 H5 A1 1 0 0 1 4 19 V7 A1 1 0 0 1 5 6 H10' }]],
    info: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M12 11 V16.5' }], ['circle', { cx: 12, cy: 7.6, r: 1.15, fill: 'currentColor', stroke: 'none' }]],
    warning: [['path', { d: 'M12 3.5 L21.5 20 H2.5 Z' }], ['path', { d: 'M12 10 V14' }], ['circle', { cx: 12, cy: 17, r: 1.05, fill: 'currentColor', stroke: 'none' }]],
    'chevron-down': [['path', { d: 'M6 9 L12 15 L18 9' }]],
    'chevron-up': [['path', { d: 'M6 15 L12 9 L18 15' }]],
    'chevron-right': [['path', { d: 'M9 6 L15 12 L9 18' }]],
    'chevron-left': [['path', { d: 'M15 6 L9 12 L15 18' }]],
    play: [['path', { d: 'M7 4.5 V19.5 L19.5 12 Z', fill: 'currentColor' }]],
    pause: [['path', { d: 'M8 5 V19 M16 5 V19' }]],
    refresh: [['path', { d: 'M20 11 A8 8 0 1 0 18.3 16.5' }], ['path', { d: 'M20.5 4 V11 H13.5' }]],
    trash: [['path', { d: 'M4 6.5 H20 M9.5 6.5 V4.5 H14.5 V6.5' }], ['path', { d: 'M6 6.5 L7 20 A1.5 1.5 0 0 0 8.5 21.5 H15.5 A1.5 1.5 0 0 0 17 20 L18 6.5' }]],
    clock: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M12 7 V12 L15.5 14' }]],
    scissors: [['circle', { cx: 6, cy: 6.5, r: 2.6 }], ['circle', { cx: 6, cy: 17.5, r: 2.6 }], ['path', { d: 'M8.2 8 L20 18.5 M8.2 16 L20 5.5' }]],
    globe: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M2.5 12 H21.5' }], ['path', { d: 'M12 2.5 C15 5.5 15 18.5 12 21.5 C9 18.5 9 5.5 12 2.5 Z' }]],
    sparkle: [['path', { d: 'M12 3 Q13.2 10.8 21 12 Q13.2 13.2 12 21 Q10.8 13.2 3 12 Q10.8 10.8 12 3 Z', fill: 'currentColor', stroke: 'none' }]],
    list: [['path', { d: 'M4 6 H16 M4 12 H16 M4 18 H11' }], ['path', { d: 'M15.5 15 L20.5 18 L15.5 21 Z', fill: 'currentColor' }]],
    film: [['rect', { x: 3, y: 3.5, width: 18, height: 17, rx: 2.5 }], ['path', { d: 'M7.5 3.5 V20.5 M16.5 3.5 V20.5 M3 9 H7.5 M3 15 H7.5 M16.5 9 H21 M16.5 15 H21' }]],
    eye: [['path', { d: 'M2 12 C4.5 7 8 4.8 12 4.8 S19.5 7 22 12 C19.5 17 16 19.2 12 19.2 S4.5 17 2 12 Z' }], ['circle', { cx: 12, cy: 12, r: 3.2 }]],
    'eye-off': [['path', { d: 'M9.9 5.1 A9.5 9.5 0 0 1 12 4.8 C16 4.8 19.5 7 22 12 A15.8 15.8 0 0 1 19.6 15.4 M14.1 14.3 A3.2 3.2 0 0 1 9.7 9.9 M17.3 17.4 A10 10 0 0 1 12 19.2 C8 19.2 4.5 17 2 12 A16 16 0 0 1 6.7 6.6' }], ['path', { d: 'M2.5 2.5 L21.5 21.5' }]],
    phone: [['rect', { x: 6.5, y: 2.5, width: 11, height: 19, rx: 2.5 }], ['path', { d: 'M10.5 9 V15 L15 12 Z', fill: 'currentColor' }]],
    rotate: [['path', { d: 'M4 12 A8 8 0 1 0 6.3 6.4' }], ['path', { d: 'M3.5 3.5 V8 H8' }]],
    flip: [['path', { d: 'M12 3 V21' }], ['path', { d: 'M9 7 L3.5 17 H9 Z' }], ['path', { d: 'M15 7 L20.5 17 H15 Z', fill: 'currentColor' }]],
    zoom: [['circle', { cx: 10.5, cy: 10.5, r: 6.5 }], ['path', { d: 'M15.5 15.5 L21 21 M10.5 7.5 V13.5 M7.5 10.5 H13.5' }]],
    sun: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2.5 V4.5 M12 19.5 V21.5 M2.5 12 H4.5 M19.5 12 H21.5 M5.3 5.3 L6.7 6.7 M17.3 17.3 L18.7 18.7 M5.3 18.7 L6.7 17.3 M17.3 6.7 L18.7 5.3' }]],
    contrast: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M12 2.5 A9.5 9.5 0 0 1 12 21.5 Z', fill: 'currentColor' }]],
    droplet: [['path', { d: 'M12 3 C12 3 5.5 10 5.5 14.5 A6.5 6.5 0 0 0 18.5 14.5 C18.5 10 12 3 12 3 Z' }]],
    keyboard: [['rect', { x: 2.5, y: 6, width: 19, height: 12, rx: 2 }], ['path', { d: 'M6 10 H6.01 M9.3 10 H9.31 M12.6 10 H12.61 M15.9 10 H15.91 M18 10 H18.01 M7.5 14 H16.5' }]],
    plug: [['path', { d: 'M9 2.5 V7 M15 2.5 V7' }], ['path', { d: 'M6 7 H18 V11 A6 6 0 0 1 12 17 A6 6 0 0 1 6 11 Z' }], ['path', { d: 'M12 17 V21.5' }]],
    plus: [['path', { d: 'M12 5 V19 M5 12 H19' }]],
    minus: [['path', { d: 'M5 12 H19' }]],
    link: [['path', { d: 'M10 14 A4.5 4.5 0 0 0 16.4 14.4 L19.4 11.4 A4.5 4.5 0 0 0 13 5 L11.5 6.5' }], ['path', { d: 'M14 10 A4.5 4.5 0 0 0 7.6 9.6 L4.6 12.6 A4.5 4.5 0 0 0 11 19 L12.5 17.5' }]],
    help: [['circle', { cx: 12, cy: 12, r: 9.5 }], ['path', { d: 'M9.3 9.2 A2.8 2.8 0 1 1 13.2 11.8 C12.4 12.2 12 12.8 12 13.6 V14' }], ['circle', { cx: 12, cy: 17.2, r: 1.05, fill: 'currentColor', stroke: 'none' }]],
    'skip-back': [['path', { d: 'M18.5 5 L9.5 12 L18.5 19 Z', fill: 'currentColor' }], ['path', { d: 'M6 5 V19' }]],
    flag: [['path', { d: 'M5 21.5 V3.5 M5 4 H17 L14.5 8 L17 12 H5' }]],
    logo: [
      ['rect', { x: 1, y: 1, width: 22, height: 22, rx: 6, fill: '#e3122b', stroke: 'none' }],
      ['path', { d: 'M12 5.6 V13.4 M8.4 10.2 L12 13.8 L15.6 10.2', stroke: '#fff', 'stroke-width': 2.2 }],
      ['path', { d: 'M6.8 15 V16.2 Q6.8 18.1 8.7 18.1 H15.3 Q17.2 18.1 17.2 16.2 V15', stroke: '#fff', 'stroke-width': 1.9 }],
    ],
  };

  /** Register extra icons (name -> array of [tag, attrs]). */
  function registerIcon(name, def) {
    ICONS[name] = def;
  }

  /**
   * icon(name, { size = 20, strokeWidth = 2, className, title })
   * Returns an <svg> element; unknown names render an empty box (and warn once).
   */
  const warned = new Set();
  function icon(name, opts) {
    const o = opts || {};
    const size = o.size || 20;
    const svg = s('svg', {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': o.strokeWidth || 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
      class: ['ayt-icon', o.className].filter(Boolean).join(' '),
    });
    const def = ICONS[name];
    if (!def) {
      if (!warned.has(name)) {
        warned.add(name);
        console.warn('[AYT] unknown icon', name);
      }
      return svg;
    }
    for (const [tag, attrs] of def) svg.appendChild(s(tag, attrs));
    if (o.title) svg.appendChild(s('title', null)).textContent = o.title;
    return svg;
  }

  function clear(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  /** Replace all children of el with the given children. */
  function render(el, ...children) {
    clear(el);
    appendChildren(el, children);
    return el;
  }

  AYT.dom = { h, s, icon, registerIcon, clear, render, ICONS, SVG_NS };
})(globalThis);
