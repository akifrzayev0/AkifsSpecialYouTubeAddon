/*
 * Akif's Special YouTube Addon — UI components (built on AYT.dom, styled by AYT.UI_CSS).
 * Shared by content-script panels, the popup and the options page.
 * Every interactive component returns { el, ... } where `el` is the root element to insert.
 */
(function (g) {
  'use strict';
  const AYT = (g.AYT = g.AYT || {});
  if (AYT.ui) return;
  const { h, icon, clear } = AYT.dom;
  const t = (k, p) => AYT.t(k, p);
  const U = AYT.util;

  let sheet = null;
  function uiSheet() {
    if (!sheet) {
      try {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(AYT.UI_CSS);
      } catch (_) {
        sheet = false;
      }
    }
    return sheet;
  }

  /* Module CSS registered with addStyles() lives in one shared constructable sheet that every
     mounted root adopts, so styles added later still reach roots that already exist. Modules add their
     CSS while the content scripts load, before anything is mounted: the sheet is parsed once, when the
     first root mounts, and CSS added after that is applied in one batch instead of one re-parse per call. */
  let moduleCss = '';
  let moduleSheet = null;
  let moduleDirty = false;
  const fallbackStyleEls = new Set();
  function flushModuleCss() {
    if (!moduleDirty || !moduleSheet) return;
    moduleDirty = false;
    try {
      moduleSheet.replaceSync(moduleCss);
    } catch (e) {
      console.error('[AYT] addStyles failed', e);
    }
  }
  function getModuleSheet() {
    if (moduleSheet === null) {
      try {
        moduleSheet = new CSSStyleSheet();
        moduleDirty = true;
      } catch (_) {
        moduleSheet = false;
      }
    }
    flushModuleCss();
    return moduleSheet;
  }

  /** Register extra CSS for a module (applies to all our shadow roots / pages). */
  function addStyles(css) {
    moduleCss += '\n' + css;
    moduleDirty = true;
    if (moduleSheet) Promise.resolve().then(flushModuleCss); // already adopted somewhere: update once per batch
    fallbackStyleEls.forEach((el) => (el.textContent = AYT.UI_CSS + '\n' + moduleCss + '\n' + (el.dataset.extra || '')));
  }

  /** Adopt the design-system CSS (+ module CSS + optional root-specific CSS) into a ShadowRoot or Document. */
  function mountStyles(root, extraCss) {
    const target = root;
    const base = uiSheet();
    const mod = getModuleSheet();
    let own = null;
    if (extraCss) {
      try {
        own = new CSSStyleSheet();
        own.replaceSync(extraCss);
      } catch (_) {
        own = false;
      }
    }
    try {
      if (!base || !mod || own === false) throw new Error('constructable sheets unsupported');
      const sheets = [base, mod].concat(own ? [own] : []);
      target.adoptedStyleSheets = [...(target.adoptedStyleSheets || []).filter((s) => !sheets.includes(s)), ...sheets];
    } catch (_) {
      const style = document.createElement('style');
      style.dataset.extra = extraCss || '';
      style.textContent = AYT.UI_CSS + '\n' + moduleCss + '\n' + (extraCss || '');
      fallbackStyleEls.add(style);
      (target.head || target).appendChild(style);
    }
  }

  /* ------------------------------------------------------------- theme */
  function youtubeIsDark() {
    const html = document.documentElement;
    if (html.hasAttribute('dark')) return true;
    if (location.hostname.endsWith('youtube.com')) return false;
    return g.matchMedia && g.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function resolveTheme() {
    let pref = 'auto';
    try {
      pref = AYT.settings ? AYT.settings.get('theme') : 'auto';
    } catch (_) {
      /* settings not loaded */
    }
    if (pref === 'dark' || pref === 'light') return pref;
    return youtubeIsDark() ? 'dark' : 'light';
  }

  const themeTargets = new Set();
  let themeWatching = false;
  /** Applies data-theme (dark/light) and lang (for correct text-transform, e.g. Turkish/Azerbaijani İ) and keeps them updated. */
  function applyTheme(el) {
    themeTargets.add(el);
    el.setAttribute('data-theme', resolveTheme());
    el.setAttribute('lang', AYT.i18n.language);
    if (!themeWatching) {
      themeWatching = true;
      AYT.i18n.onChange((lang) => themeTargets.forEach((x) => x.setAttribute('lang', lang)));
      const update = () => themeTargets.forEach((x) => x.setAttribute('data-theme', resolveTheme()));
      try {
        new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });
      } catch (_) {
        /* ignore */
      }
      try {
        g.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', update);
      } catch (_) {
        /* ignore */
      }
      if (AYT.settings) AYT.settings.onChange((c) => { if ('theme' in c) update(); });
    }
    return () => themeTargets.delete(el);
  }

  /* ------------------------------------------------------------- basic controls */
  /**
   * False for an event a page script made (content scripts only: AYT.keys comes from content/core.js). Our roots
   * drop such events already (AYT.keys.guard); this also covers a control a page script moved out of its root.
   */
  function userEvent(e) {
    return !(AYT.keys && typeof AYT.keys.trusted === 'function' && !AYT.keys.trusted(e));
  }

  function button(o) {
    const opts = o || {};
    const cls = ['ayt-btn'];
    if (opts.variant) cls.push('ayt-btn--' + opts.variant);
    if (opts.size === 'sm') cls.push('ayt-btn--sm');
    if (opts.block) cls.push('ayt-btn--block');
    if (!opts.label && opts.icon) cls.push('ayt-btn--icon');
    if (opts.className) cls.push(opts.className);
    const el = h(
      'button',
      {
        type: 'button',
        class: cls,
        title: opts.title || null,
        disabled: !!opts.disabled,
        // A visible label is the accessible name (WCAG 2.5.3: voice users say what they see); the title then
        // becomes the description. Only icon-only buttons are named by their title.
        'aria-label': opts.ariaLabel || (opts.label ? null : opts.title) || null,
        on: { click: (e) => { if (!el.disabled && opts.onClick && userEvent(e)) opts.onClick(e); } },
      },
      opts.icon ? icon(opts.icon, { size: opts.size === 'sm' ? 16 : 18 }) : null,
      opts.label ? h('span', null, opts.label) : null
    );
    return el;
  }

  function select(o) {
    const opts = o || {};
    const sel = h('select', {
      class: 'ayt-select',
      'aria-label': opts.ariaLabel || null,
      disabled: !!opts.disabled,
      on: { change: () => opts.onChange && opts.onChange(sel.value) },
    });
    const wrap = h('label', { class: 'ayt-select-wrap' }, sel, icon('chevron-down', { size: 18 }));
    function setOptions(options, value) {
      clear(sel);
      const groups = new Map();
      for (const op of options || []) {
        // lang: the language the label is written in (screen readers switch voice, e.g. "Русский" in a language list)
        const node = h('option', { value: String(op.value), disabled: !!op.disabled, lang: op.lang || null }, op.label);
        if (op.group) {
          if (!groups.has(op.group)) {
            const gEl = h('optgroup', { label: op.group });
            groups.set(op.group, gEl);
            sel.appendChild(gEl);
          }
          groups.get(op.group).appendChild(node);
        } else sel.appendChild(node);
      }
      if (value !== undefined) sel.value = String(value);
    }
    setOptions(opts.options, opts.value);
    return {
      el: wrap,
      select: sel,
      setOptions,
      get value() {
        return sel.value;
      },
      set value(v) {
        sel.value = String(v);
      },
      set disabled(v) {
        sel.disabled = !!v;
      },
    };
  }

  function segmented(o) {
    const opts = o || {};
    let value = opts.value;
    const el = h('div', { class: 'ayt-seg', role: 'radiogroup', 'aria-label': opts.ariaLabel || null });
    const buttons = [];
    function sync() {
      for (const b of buttons) {
        const on = b.dataset.value === String(value);
        b.classList.toggle('is-selected', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      }
    }
    function choose(v) {
      if (String(value) === String(v)) return;
      value = v;
      sync();
      if (opts.onChange) opts.onChange(value);
    }
    const options = opts.options || [];
    options.forEach((op) => {
      const b = h(
        'button',
        {
          type: 'button',
          class: 'ayt-seg__opt',
          role: 'radio',
          title: op.title || null,
          dataset: { value: op.value },
          disabled: !!op.disabled,
          on: {
            click: (e) => {
              if (userEvent(e)) choose(op.value);
            },
            // Arrow keys move to the next enabled option and select it (radio group pattern). The option is
            // selected directly: a scripted next.click() would be dropped as untrusted by AYT.keys.guard.
            keydown: (e) => {
              if ((e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') || !userEvent(e)) return;
              e.preventDefault();
              const step = e.key === 'ArrowRight' ? 1 : -1;
              const from = buttons.indexOf(b);
              for (let n = 1; n < buttons.length; n++) {
                const i = (((from + step * n) % buttons.length) + buttons.length) % buttons.length;
                if (buttons[i].disabled) continue;
                buttons[i].focus();
                choose(options[i].value);
                return;
              }
            },
          },
        },
        op.icon ? icon(op.icon, { size: 16 }) : null,
        op.label != null ? h('span', null, op.label) : null
      );
      buttons.push(b);
      el.appendChild(b);
    });
    sync();
    return {
      el,
      get value() {
        return value;
      },
      set value(v) {
        value = v;
        sync();
      },
    };
  }

  let radioSeq = 0;
  function radioList(o) {
    const opts = o || {};
    const name = opts.name || 'ayt-radio-' + ++radioSeq;
    let value = opts.value;
    const el = h('div', { class: 'ayt-radio-list', role: 'radiogroup', 'aria-label': opts.ariaLabel || null });
    function build(options) {
      clear(el);
      for (const op of options || []) {
        const input = h('input', {
          type: 'radio',
          name,
          value: String(op.value),
          checked: String(op.value) === String(value),
          disabled: !!op.disabled,
          on: {
            change: () => {
              value = op.value;
              sync();
              opts.onChange && opts.onChange(value);
            },
          },
        });
        el.appendChild(
          h(
            'label',
            { class: ['ayt-radio', String(op.value) === String(value) && 'is-selected', op.disabled && 'is-disabled'], dataset: { value: op.value } },
            input,
            h('span', { class: 'ayt-radio__dot' }),
            h('span', { class: 'ayt-radio__text' }, h('span', { class: 'ayt-radio__label' }, op.label), op.desc ? h('span', { class: 'ayt-radio__desc' }, op.desc) : null)
          )
        );
      }
    }
    function sync() {
      el.querySelectorAll('.ayt-radio').forEach((lab) => {
        const on = lab.dataset.value === String(value);
        lab.classList.toggle('is-selected', on);
        const inp = lab.querySelector('input');
        if (inp) inp.checked = on;
      });
    }
    build(opts.options);
    return {
      el,
      setOptions(options, v) {
        if (v !== undefined) value = v;
        build(options);
      },
      get value() {
        return value;
      },
      set value(v) {
        value = v;
        sync();
      },
    };
  }

  function switchControl(o) {
    const opts = o || {};
    const input = h('input', {
      type: 'checkbox',
      checked: !!opts.checked,
      disabled: !!opts.disabled,
      'aria-label': opts.label || null,
      on: { change: () => opts.onChange && opts.onChange(input.checked) },
    });
    const el = h(
      'label',
      { class: ['ayt-switch', opts.disabled && 'is-disabled'] },
      input,
      h('span', { class: 'ayt-switch__track' }),
      opts.label || opts.desc
        ? h('span', { class: 'ayt-switch__text' }, opts.label ? h('span', { class: 'ayt-switch__label' }, opts.label) : null, opts.desc ? h('span', { class: 'ayt-switch__desc' }, opts.desc) : null)
        : null
    );
    return {
      el,
      input,
      get checked() {
        return input.checked;
      },
      set checked(v) {
        input.checked = !!v;
      },
      set disabled(v) {
        input.disabled = !!v;
        el.classList.toggle('is-disabled', !!v);
      },
    };
  }

  function setPct(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--pct', pct + '%');
  }

  function slider(o) {
    const opts = o || {};
    const fmt = opts.format || ((v) => String(v));
    const valueEl = h('span', { class: 'ayt-slider__value' });
    const input = h('input', {
      type: 'range',
      class: 'ayt-range-input',
      min: opts.min != null ? opts.min : 0,
      max: opts.max != null ? opts.max : 100,
      step: opts.step != null ? opts.step : 1,
      value: opts.value != null ? opts.value : 0,
      'aria-label': opts.ariaLabel || null,
      on: {
        input: () => {
          setPct(input);
          valueEl.textContent = fmt(Number(input.value));
          opts.onInput && opts.onInput(Number(input.value));
        },
        change: () => opts.onChange && opts.onChange(Number(input.value)),
      },
    });
    setPct(input);
    valueEl.textContent = fmt(Number(input.value));
    const el = h('div', { class: 'ayt-slider' }, input, opts.showValue === false ? null : valueEl);
    return {
      el,
      input,
      get value() {
        return Number(input.value);
      },
      set value(v) {
        input.value = String(v);
        setPct(input);
        valueEl.textContent = fmt(Number(input.value));
      },
      setBounds(min, max) {
        input.min = String(min);
        input.max = String(max);
        setPct(input);
        valueEl.textContent = fmt(Number(input.value));
      },
    };
  }

  /** Dual-thumb range slider. Values are numbers (e.g. seconds). */
  function rangeSlider(o) {
    const opts = o || {};
    let min = opts.min || 0;
    let max = opts.max != null ? opts.max : 100;
    const step = opts.step || 1;
    const gap = opts.minGap != null ? opts.minGap : step;
    const fmt = opts.format || ((v) => String(v));
    const root = h('div', { class: 'ayt-dual' });
    const fill = h('div', { class: 'ayt-dual__fill' });
    const mk = (val, label) =>
      h('input', { type: 'range', min, max, step, value: val, 'aria-label': label || null });
    const a = mk(opts.start != null ? opts.start : min, opts.startLabel);
    const b = mk(opts.end != null ? opts.end : max, opts.endLabel);
    const la = h('span');
    const lb = h('span');
    root.append(h('div', { class: 'ayt-dual__track' }), fill, a, b);
    const el = h('div', null, root, opts.showLabels === false ? null : h('div', { class: 'ayt-dual__labels' }, la, lb));

    function paint() {
      const span = max - min || 1;
      root.style.setProperty('--a', ((Number(a.value) - min) / span) * 100 + '%');
      root.style.setProperty('--b', ((Number(b.value) - min) / span) * 100 + '%');
      la.textContent = fmt(Number(a.value));
      lb.textContent = fmt(Number(b.value));
    }
    function constrain(which) {
      let va = Number(a.value);
      let vb = Number(b.value);
      if (vb - va < gap) {
        if (which === 'a') va = Math.max(min, vb - gap);
        else vb = Math.min(max, va + gap);
        a.value = String(va);
        b.value = String(vb);
      }
    }
    a.addEventListener('input', () => {
      constrain('a');
      a.style.zIndex = 3;
      b.style.zIndex = 2;
      paint();
      opts.onInput && opts.onInput(Number(a.value), Number(b.value), 'start');
    });
    b.addEventListener('input', () => {
      constrain('b');
      b.style.zIndex = 3;
      a.style.zIndex = 2;
      paint();
      opts.onInput && opts.onInput(Number(a.value), Number(b.value), 'end');
    });
    const changed = () => opts.onChange && opts.onChange(Number(a.value), Number(b.value));
    a.addEventListener('change', changed);
    b.addEventListener('change', changed);
    paint();
    return {
      el,
      get start() {
        return Number(a.value);
      },
      get end() {
        return Number(b.value);
      },
      set(start, end) {
        a.value = String(U.clamp(start, min, max));
        b.value = String(U.clamp(end, min, max));
        constrain('b');
        paint();
      },
      setBounds(newMin, newMax) {
        min = newMin;
        max = newMax;
        for (const x of [a, b]) {
          x.min = String(min);
          x.max = String(max);
        }
        paint();
      },
    };
  }

  let fieldSeq = 0;
  /**
   * HH:MM:SS(.mmm) text input. value in seconds.
   * A rejected entry sets aria-invalid and explains itself in `errorEl` (warning icon + text, role=alert,
   * linked with aria-describedby): put errorEl under the input. It is hidden while the value is valid.
   */
  function timeInput(o) {
    const opts = o || {};
    let value = opts.value || 0;
    const withMs = !!opts.withMs;
    const errorId = 'ayt-time-error-' + ++fieldSeq;
    const errorText = h('span');
    const errorEl = h('div', { class: 'ayt-field-error ayt-hidden', id: errorId, role: 'alert' }, icon('warning', { size: 14 }), errorText);
    const input = h('input', {
      type: 'text',
      class: 'ayt-input ayt-input--time',
      inputMode: 'numeric',
      spellcheck: false,
      autocomplete: 'off',
      'aria-label': opts.ariaLabel || null,
      'aria-describedby': errorId,
      value: U.formatClock(value, withMs),
    });
    function setError(message) {
      if (errorText.textContent !== message) errorText.textContent = message;
      errorEl.classList.toggle('ayt-hidden', !message);
      input.classList.toggle('is-invalid', !!message);
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    function commit() {
      const v = U.parseClock(input.value);
      const lo = opts.min != null ? opts.min : 0;
      const hi = opts.max != null ? opts.max : Infinity;
      if (!isFinite(v) || v < lo || v > hi) {
        setError(
          isFinite(hi)
            ? t('common.invalidTime', { min: U.formatClock(lo, withMs), max: U.formatClock(hi, withMs) })
            : t('common.invalidTimeFormat', { example: U.formatClock(90, withMs) })
        );
        return;
      }
      setError('');
      value = v;
      input.value = U.formatClock(value, withMs);
      opts.onChange && opts.onChange(value);
    }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
      // keep YouTube's keyboard shortcuts from firing while typing; Escape goes on so it closes the panel
      if (e.key !== 'Escape') e.stopPropagation();
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('keypress', (e) => e.stopPropagation());
    return {
      el: input,
      errorEl,
      get value() {
        return value;
      },
      set value(v) {
        value = v;
        setError('');
        input.value = U.formatClock(v, withMs);
      },
      setMax(m) {
        opts.max = m;
      },
    };
  }

  function textInput(o) {
    const opts = o || {};
    const input = h('input', {
      type: opts.type || 'text',
      class: 'ayt-input',
      placeholder: opts.placeholder || null,
      value: opts.value || '',
      spellcheck: false,
      'aria-label': opts.ariaLabel || null,
      on: {
        change: () => opts.onChange && opts.onChange(input.value),
        input: () => opts.onInput && opts.onInput(input.value),
      },
    });
    // keep YouTube's keyboard shortcuts from firing while typing; Escape keydown goes on so it closes the panel
    for (const ev of ['keydown', 'keyup', 'keypress']) {
      input.addEventListener(ev, (e) => {
        if (ev !== 'keydown' || e.key !== 'Escape') e.stopPropagation();
      });
    }
    return { el: input, get value() { return input.value; }, set value(v) { input.value = v; } };
  }

  function progress(o) {
    const opts = o || {};
    const bar = h('div', { class: 'ayt-progress__bar' });
    const el = h('div', { class: 'ayt-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
    let shown; // last value painted (null = indeterminate); repeated pushes with the same value change nothing
    function set(v) {
      const pct = v == null || !isFinite(v) ? null : Math.round(U.clamp(v, 0, 100) * 10) / 10;
      if (pct === shown) return;
      shown = pct;
      if (pct === null) {
        el.classList.add('is-indeterminate');
        el.removeAttribute('aria-valuenow');
      } else {
        el.classList.remove('is-indeterminate');
        bar.style.width = pct + '%';
        el.setAttribute('aria-valuenow', String(Math.round(pct)));
      }
    }
    set(opts.value);
    return {
      el,
      set,
      /** state: 'done' | 'warn' (finished with problems) | 'error' | null (running). */
      setState(state) {
        el.classList.toggle('is-done', state === 'done');
        el.classList.toggle('is-warn', state === 'warn');
        el.classList.toggle('is-error', state === 'error');
        if (state === 'done' || state === 'warn') set(100);
      },
    };
  }

  function badge(text, variant) {
    return h('span', { class: ['ayt-badge', variant && 'ayt-badge--' + variant] }, text);
  }

  const NOTICE_ICONS = { info: 'info', warn: 'warning', error: 'warning', success: 'check-circle' };
  function notice(o) {
    const opts = o || {};
    const kind = opts.kind || 'info';
    return h(
      'div',
      { class: ['ayt-notice', 'ayt-notice--' + kind], role: kind === 'error' ? 'alert' : 'status' },
      icon(opts.icon || NOTICE_ICONS[kind] || 'info', { size: 18 }),
      h(
        'div',
        { class: 'ayt-notice__body' },
        opts.title ? h('div', { class: 'ayt-notice__title' }, opts.title) : null,
        opts.text ? h('div', null, opts.text) : null,
        opts.children || null,
        opts.actions && opts.actions.length
          ? h('div', { class: 'ayt-notice__actions' }, opts.actions.map((a) => button({ label: a.label, icon: a.icon, size: 'sm', variant: a.variant, onClick: a.onClick })))
          : null
      )
    );
  }

  function spinner() {
    return h('div', { class: 'ayt-spinner', role: 'status', 'aria-label': t('common.loading') });
  }

  function field(label, control, hint) {
    return h(
      'div',
      { class: 'ayt-field' },
      label ? h('div', { class: 'ayt-label' }, label) : null,
      control,
      hint ? h('div', { class: 'ayt-hint' }, hint) : null
    );
  }

  /* ------------------------------------------------------------- toast */
  let toastBox = null;
  function toastContainer() {
    if (toastBox && toastBox.isConnected) return toastBox;
    const host = h('div', { id: 'ayt-toast-host', style: 'all: initial; position: fixed; z-index: 2147483000; top: 0; left: 0; width: 0; height: 0;' });
    const root = host.attachShadow({ mode: 'open' });
    if (AYT.keys) {
      // Content scripts: drop script-made events (AYT.keys.guard) and keep keys pressed on a toast's buttons
      // from reaching YouTube's shortcuts (Space would also pause the video); Escape closes the focused toast.
      if (typeof AYT.keys.isolate === 'function') AYT.keys.isolate(root, closeToastOf);
      else AYT.keys.guard(root);
    }
    mountStyles(root);
    const wrap = h('div', { class: 'ayt-root' });
    applyTheme(wrap);
    toastBox = h('div', { class: 'ayt-toasts', 'aria-live': 'polite' });
    wrap.appendChild(toastBox);
    root.appendChild(wrap);
    (document.body || document.documentElement).appendChild(host);
    return toastBox;
  }

  /** Escape pressed in a toast closes that toast (AYT.keys.isolate onEscape; false = not handled). */
  function closeToastOf(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const item = path.find((n) => n && n._aytToast);
    if (!item) return false;
    item._aytToast.handle.close();
    return true;
  }

  /** The focused element, looking inside open shadow roots (YouTube and our panels use them). */
  function deepActiveElement() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  const TOAST_ICONS = { success: 'check-circle', error: 'warning', warn: 'warning', info: 'info' };
  const TOAST_ACTION_MIN_MS = 20000; // time to reach the action button (WCAG 2.2.1)
  /**
   * toast(text, { kind: 'info'|'success'|'error'|'warn', duration, action: { label, onClick }, focusAction })
   * - pauses while hovered or focused; a toast with an action stays at least 20 s (duration 0 = until closed);
   * - focusAction: true moves keyboard focus to the action and back when the toast closes (use it when the
   *   toast answers a keyboard shortcut);
   * - the same text again while it is still shown restarts that toast instead of stacking a copy;
   * - on YouTube, keys pressed in a toast stay out of the page's shortcuts and Escape closes it.
   */
  function toast(text, o) {
    const opts = o || {};
    const kind = opts.kind || 'info';
    const box = toastContainer();
    const key = typeof text === 'string' ? kind + '|' + text : null;
    for (const old of Array.from(box.children)) {
      if (key !== null && old._aytToast && old._aytToast.key === key && !old.classList.contains('is-leaving')) {
        old._aytToast.restart();
        return old._aytToast.handle;
      }
    }
    let dur = opts.duration != null ? opts.duration : kind === 'error' ? 7000 : 3500;
    if (opts.action && dur > 0) dur = Math.max(dur, TOAST_ACTION_MIN_MS);
    let timer = 0;
    let hovered = false;
    let focused = false;
    let closed = false;
    const takeFocus = !!(opts.action && opts.focusAction);
    const returnFocus = takeFocus ? deepActiveElement() : null;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      const root = el.getRootNode();
      const hadFocus = !!(root && root.activeElement && el.contains(root.activeElement));
      if (hadFocus && returnFocus && returnFocus.isConnected) {
        try {
          returnFocus.focus({ preventScroll: true });
        } catch (_) {
          /* ignore */
        }
      }
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 220);
    };
    const restart = () => {
      clearTimeout(timer);
      if (dur > 0 && !hovered && !focused) timer = setTimeout(close, dur);
    };
    const actionBtn = opts.action
      ? button({ label: opts.action.label, size: 'sm', variant: 'ghost', onClick: () => { opts.action.onClick(); close(); } })
      : null;
    const el = h(
      'div',
      { class: ['ayt-toast', 'ayt-toast--' + kind], role: kind === 'error' ? 'alert' : 'status' },
      icon(TOAST_ICONS[kind] || 'info', { size: 18 }),
      h('div', { class: 'ayt-toast__text' }, text),
      actionBtn,
      button({ icon: 'x', size: 'sm', variant: 'ghost', title: t('common.close'), onClick: close })
    );
    const handle = { close };
    el._aytToast = { key, restart, handle };
    box.appendChild(el);
    while (box.children.length > 4) box.firstElementChild.remove();
    restart();
    const resume = () => {
      clearTimeout(timer);
      if (dur > 0 && !hovered && !focused) timer = setTimeout(close, 1500);
    };
    el.addEventListener('mouseenter', () => {
      hovered = true;
      clearTimeout(timer);
    });
    el.addEventListener('mouseleave', () => {
      hovered = false;
      resume();
    });
    el.addEventListener('focusin', () => {
      focused = true;
      clearTimeout(timer);
    });
    el.addEventListener('focusout', (e) => {
      if (el.contains(e.relatedTarget)) return;
      focused = false;
      resume();
    });
    if (takeFocus) {
      try {
        actionBtn.focus({ preventScroll: true });
      } catch (_) {
        /* ignore */
      }
    }
    return handle;
  }

  /* ------------------------------------------------------------- jobs */
  /** A finished playlist job some of whose videos could not be downloaded (the host reports them in failedItems). */
  function isPartial(job) {
    return !!job && job.status === 'done' && typeof job.failedItems === 'number' && job.failedItems > 0;
  }

  function formatCount(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    try {
      return v.toLocaleString(AYT.i18n.language);
    } catch (_) {
      return String(v);
    }
  }

  function jobStatusText(job) {
    switch (job.status) {
      case 'queued':
        return t('job.status.queued');
      case 'starting':
        return t('job.status.starting');
      case 'done': {
        const size = job.fileSize ? U.formatBytes(job.fileSize) : '';
        if (isPartial(job)) {
          // count-safe ("Downloaded: 8 · Failed: 2"), so every language reads well with any number
          const counts = { done: formatCount(job.fileCount), failed: formatCount(job.failedItems) };
          return size ? t('job.status.donePartialSize', Object.assign(counts, { size })) : t('job.status.donePartial', counts);
        }
        return size ? t('job.status.doneSize', { size }) : t('job.status.done');
      }
      case 'error':
        return t('job.status.error');
      case 'canceled':
        return t('job.status.canceled');
      default: {
        const stageKey = 'job.stage.' + (job.stage || 'download');
        return AYT.i18n.has(stageKey) ? t(stageKey) : t('job.stage.download');
      }
    }
  }

  /** Sets a span's text (only when it changed) and hides it while empty. */
  function setPart(node, text) {
    if (node.textContent !== text) node.textContent = text;
    node.classList.toggle('ayt-hidden', !text);
  }

  /**
   * One job row. update(job, force) only touches what changed: progress pushes arrive several times a
   * second, and rebuilding the buttons each time would swallow clicks and drop keyboard focus.
   */
  function jobItem(initialJob, o) {
    const opts = o || {};
    let job = initialJob;
    let actionsMode = '';
    const title = h('div', { class: 'ayt-job__title' });
    const parts = { status: h('span'), playlist: h('span'), percent: h('span'), speed: h('span'), eta: h('span'), bytes: h('span') };
    const meta = h('div', { class: 'ayt-job__meta' }, Object.values(parts));
    const actions = h('div', { class: 'ayt-job__actions' });
    const prog = progress({ value: 0 });
    const errorEl = h('div', { class: 'ayt-job__error' });
    const el = h('div', { class: 'ayt-job' }, h('div', { class: 'ayt-job__top' }, icon(kindIcon(job.kind), { size: 18 }), title, actions), prog.el, meta, errorEl);

    function kindIcon(kind) {
      return { video: 'video', audio: 'music', subtitle: 'cc', gif: 'film' }[kind] || 'download';
    }

    function renderActions(active) {
      const root = typeof actions.getRootNode === 'function' ? actions.getRootNode() : null;
      const hadFocus = !!(root && root.activeElement && actions.contains(root.activeElement));
      clear(actions);
      const retryBtn = () => button({ icon: 'refresh', size: 'sm', variant: 'ghost', title: t('common.retry'), onClick: () => AYT.client.jobs.retry(job.id).catch(showError) });
      if (active) {
        actions.appendChild(button({ icon: 'x', size: 'sm', variant: 'ghost', title: t('common.cancel'), onClick: () => AYT.client.jobs.cancel(job.id).catch(showError) }));
      } else if (job.status === 'done') {
        actions.appendChild(button({ icon: 'play', size: 'sm', variant: 'ghost', title: t('job.openFile'), onClick: () => AYT.client.jobs.open(job.id, 'file').catch(showError) }));
        actions.appendChild(button({ icon: 'folder', size: 'sm', variant: 'ghost', title: t('job.showInFolder'), onClick: () => AYT.client.jobs.open(job.id, 'folder').catch(showError) }));
        if (isPartial(job)) actions.appendChild(retryBtn()); // a playlist with failed videos: run it again
      } else {
        actions.appendChild(retryBtn());
      }
      if (!active && opts.removable !== false) {
        actions.appendChild(button({ icon: 'trash', size: 'sm', variant: 'ghost', title: t('common.remove'), onClick: () => AYT.client.jobs.remove(job.id).catch(showError) }));
      }
      // keep keyboard users in the row when its buttons change (e.g. Cancel -> Open file when the job ends)
      if (hadFocus && actions.firstElementChild) actions.firstElementChild.focus({ preventScroll: true });
    }

    /** Repaints the row for `next` (the same job, newer state). force = also rebuild texts set once (language change). */
    function update(next, force) {
      job = next || job;
      const active = AYT.client.jobs.isActive(job);
      const partial = isPartial(job);
      const jobLabel = U.jobLabel ? U.jobLabel(job) : job.label || ''; // follows the UI language
      const label = opts.showTitle === false ? jobLabel : [job.title, jobLabel].filter(Boolean).join(' · ');
      if (title.textContent !== label) {
        title.textContent = label;
        title.title = label;
      }
      setPart(parts.status, jobStatusText(job));
      parts.status.classList.toggle('is-error', job.status === 'error');
      parts.status.classList.toggle('is-done', job.status === 'done' && !partial);
      parts.status.classList.toggle('is-warn', partial);
      setPart(parts.playlist, active && job.playlist && job.playlist.count ? t('job.playlistItem', { index: job.playlist.index || 1, count: job.playlist.count }) : '');
      setPart(parts.percent, active && job.percent != null && job.status !== 'queued' ? U.formatPercent(Math.floor(job.percent)) : '');
      setPart(parts.speed, active && job.speed ? U.formatSpeed(job.speed) : '');
      setPart(parts.eta, active && job.eta != null && job.eta > 0 ? t('job.eta', { time: U.formatEta(job.eta) }) : '');
      setPart(parts.bytes, active && job.total ? U.formatBytes(job.downloaded || 0) + ' / ' + U.formatBytes(job.total) : '');
      if (job.status === 'done') prog.setState(partial ? 'warn' : 'done');
      else if (job.status === 'error' || job.status === 'canceled') {
        prog.setState('error');
        prog.set(job.percent || 0);
      } else {
        prog.setState(null);
        prog.set(job.status === 'queued' || job.status === 'starting' || job.percent == null ? null : job.percent);
      }
      // compact rows drop the bar of a complete job; a partial playlist keeps its amber one
      prog.el.classList.toggle('ayt-hidden', !!(job.status === 'done' && !partial && opts.compact));
      // the host's reason can name a file: no folders (they hold the Windows user name; page scripts read our roots)
      setPart(errorEl, job.status === 'error' && job.error ? U.hidePaths(job.error) : '');

      const mode = active ? 'active' : partial ? 'partial' : job.status === 'done' ? 'done' : 'failed';
      if (force || mode !== actionsMode) {
        actionsMode = mode;
        renderActions(active);
      }
    }
    update(job);
    return { el, update, get job() { return job; } };
  }

  function showError(e) {
    if (e && e.code === 'invalidated') {
      // The extension was reloaded: the page needs a refresh. toast() keeps one copy of this message
      // (the toolbar shows the same one when it notices).
      toast(e.message || t('toolbar.invalidated'), { kind: 'warn', duration: 0, action: { label: t('toolbar.refresh'), onClick: () => location.reload() } });
      return;
    }
    toast((e && e.message) || String(e), { kind: 'error' });
  }

  /**
   * Self-updating job list. filter(job) -> boolean. Retains the live port while mounted.
   * Call destroy() when the list is removed.
   */
  function jobList(o) {
    const opts = o || {};
    const el = h('div', { class: 'ayt-jobs' });
    const items = new Map();
    function renderAll(all, force) {
      const jobs = (all || AYT.client.jobs.list()).filter((j) => !opts.filter || opts.filter(j)).slice(0, opts.max || 50);
      const seen = new Set();
      jobs.forEach((job, idx) => {
        seen.add(job.id);
        let item = items.get(job.id);
        if (!item) {
          item = jobItem(job, opts);
          items.set(job.id, item);
        } else if (force || item.job !== job) item.update(job, force); // AYT.client replaces only the job that changed
        if (el.children[idx] !== item.el) el.insertBefore(item.el, el.children[idx] || null);
      });
      for (const [id, item] of items) {
        if (!seen.has(id)) {
          item.el.remove();
          items.delete(id);
        }
      }
      el.classList.toggle('ayt-hidden', jobs.length === 0 && !opts.emptyText);
      if (jobs.length === 0 && opts.emptyText) {
        if (!el.querySelector('.ayt-jobs__empty')) el.appendChild(h('div', { class: 'ayt-hint ayt-jobs__empty' }, opts.emptyText));
      } else {
        const empty = el.querySelector('.ayt-jobs__empty');
        if (empty) empty.remove();
      }
      if (opts.onChange) opts.onChange(jobs);
    }
    const off = AYT.client.on('jobs', (all) => renderAll(all));
    const offLang = AYT.i18n.onChange(() => renderAll(null, true));
    if (opts.retain !== false) AYT.client.retain();
    renderAll();
    let destroyed = false;
    return {
      el,
      refresh: () => renderAll(null, true),
      destroy() {
        if (destroyed) return;
        destroyed = true;
        off();
        offLang();
        if (opts.retain !== false) AYT.client.release();
      },
    };
  }

  /* ------------------------------------------------------------- companion missing */
  /**
   * Notice for a companion that is missing, outdated, blocked or failing, with "How to install" and
   * "Check again". opts.text replaces the default "not installed" explanation (e.g. for subtitles).
   */
  function hostNotice(status, o) {
    const opts = o || {};
    const state = status && status.state;
    let kind = 'warn';
    let title = t('host.missing.title');
    let text = opts.text || t('host.missing.text');
    if (state === 'error') {
      kind = 'error';
      title = t('host.error.title');
      text = (status && status.error) || t('host.error.text');
    } else if (state === 'outdated') {
      title = t('host.outdated.title');
      text = t('host.outdated.text');
    } else if (state === 'forbidden') {
      // installed, but registered for another extension ID (or blocked by policy)
      kind = 'error';
      title = t('host.forbidden.title');
      text = (status && status.error) || t('host.forbidden.text');
    }
    // Blocked by an administrator policy: there is nothing to install; the options page explains it (like the popup).
    const policy = state === 'forbidden' && status.reason === 'policy';
    return notice({
      kind,
      title,
      text,
      actions: [
        { label: policy ? t('common.learnMore') : t('host.howToInstall'), icon: 'info', variant: 'primary', onClick: () => AYT.client.send(AYT.MSG.OPEN_OPTIONS, { section: 'companion' }).catch(showError) },
        { label: t('host.checkAgain'), icon: 'refresh', onClick: () => AYT.client.host.refresh(true).then((s) => opts.onRecheck && opts.onRecheck(s)).catch(showError) },
      ],
    });
  }

  AYT.ui = {
    mountStyles,
    addStyles,
    applyTheme,
    resolveTheme,
    button,
    select,
    segmented,
    radioList,
    switchControl,
    slider,
    rangeSlider,
    timeInput,
    textInput,
    progress,
    badge,
    notice,
    spinner,
    field,
    toast,
    jobItem,
    jobList,
    jobStatusText,
    hostNotice,
    showError,
  };
})(globalThis);
