/*
 * Akif's Special YouTube Addon — options page.
 *
 * Left navigation + one section at a time (hash routing: #general, #companion, #downloads, ...).
 * Every AYT.DEFAULT_SETTINGS key has a control; changes are validated (AYT.pages.validateSetting) and
 * saved instantly with a subtle "Saved" indicator. Controls stay in sync with changes made elsewhere
 * (popup, toolbar) through AYT.settings.onChange, and the whole page re-renders when the UI language
 * changes. Settings added later by other modules (unknown keys) get generic controls under "Advanced".
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  const { h, icon, clear } = AYT.dom;
  const ui = AYT.ui;
  const P = AYT.pages;
  const U = AYT.util;
  const t = (k, p) => AYT.t(k, p);
  const S = (name) => AYT.settings.get(name);

  const app = document.getElementById('app');

  // Theme as early as possible (system theme until settings are loaded).
  ui.mountStyles(document);
  ui.applyTheme(document.documentElement);

  /** Setting keys that have a dedicated control on this page. Others are shown under "Advanced". */
  const HANDLED = new Set([
    'language', 'theme', 'toolbarHidden', 'showOnShorts', 'shortsToWatch',
    'outputDir', 'subfolder', 'filenameStyle', 'videoContainer', 'videoCodec', 'audioFormat', 'audioBitrate',
    'embedThumbnail', 'embedMetadata', 'embedChapters', 'embedSubtitles', 'useCookies', 'maxConcurrent',
    'notifyOnComplete', 'askWhereToSave',
    'screenshotFormat', 'screenshotQuality', 'screenshotAction',
    'thumbnailFormat', 'subtitleFormat', 'subtitleLang',
    'autoQuality', 'rememberSpeed', 'cinemaOpacity', 'boostMax',
    'hideComments', 'hideRelated', 'hideShorts', 'hideEndscreen', 'hideLiveChat',
  ]);
  const extraSettings = () => Object.keys(AYT.DEFAULT_SETTINGS).filter((k) => !HANDLED.has(k));

  const SECTIONS = [
    { id: 'general', icon: 'settings', title: () => t('pages.nav.general'), desc: () => t('pages.general.desc'), render: renderGeneral },
    { id: 'companion', icon: 'plug', title: () => t('pages.nav.companion'), desc: () => t('pages.companion.desc'), render: renderCompanion },
    { id: 'downloads', icon: 'download', title: () => t('pages.nav.downloads'), desc: () => t('pages.downloads.desc'), render: renderDownloads },
    { id: 'screenshots', icon: 'camera', title: () => t('pages.nav.screenshots'), desc: () => t('pages.shots.desc'), render: renderScreenshots },
    { id: 'media', icon: 'cc', title: () => t('pages.nav.media'), desc: () => t('pages.media.desc'), render: renderMedia },
    { id: 'player', icon: 'play', title: () => t('pages.nav.player'), desc: () => t('pages.player.desc'), render: renderPlayer },
    { id: 'cleanup', icon: 'eye-off', title: () => t('pages.nav.cleanup'), desc: () => t('pages.cleanup.desc'), render: renderCleanup },
    { id: 'shortcuts', icon: 'keyboard', title: () => t('pages.nav.shortcuts'), desc: () => t('pages.shortcuts.desc'), render: renderShortcuts },
    { id: 'backup', icon: 'file', title: () => t('pages.nav.backup'), desc: () => t('pages.backup.desc'), render: renderBackup },
    { id: 'about', icon: 'info', title: () => t('pages.nav.about'), desc: () => t('pages.about.desc'), render: renderAbout },
    { id: 'advanced', icon: 'sliders', title: () => t('pages.nav.advanced'), desc: () => t('pages.advanced.desc'), render: renderAdvanced, hidden: () => !extraSettings().length },
  ];

  /** Section names other modules might pass to OPEN_OPTIONS { section }. */
  const ALIASES = {
    toolbar: 'general', appearance: 'general', language: 'general', theme: 'general', shorts: 'general',
    host: 'companion', install: 'companion', app: 'companion',
    folder: 'downloads', video: 'downloads', audio: 'downloads', download: 'downloads',
    screenshot: 'screenshots',
    thumbnail: 'media', thumbnails: 'media', subtitle: 'media', subtitles: 'media',
    tools: 'player', speed: 'player', boost: 'player', cinema: 'player', quality: 'player',
    interface: 'cleanup', comments: 'cleanup', hide: 'cleanup',
    keyboard: 'shortcuts', commands: 'shortcuts', keys: 'shortcuts',
    import: 'backup', export: 'backup', reset: 'backup',
    privacy: 'about', legal: 'about', credits: 'about',
  };

  const COMMANDS = [
    ['_execute_action', 'sparkle', () => t('pages.cmd.openPopup')],
    ['open-download', 'download', () => t('pages.cmd.download')],
    ['take-screenshot', 'camera', () => t('pages.cmd.screenshot')],
    ['toggle-loop', 'loop', () => t('pages.cmd.loop')],
    ['toggle-cinema', 'bulb', () => t('pages.cmd.cinema')],
    ['toggle-pip', 'pip', () => t('pages.cmd.pip')],
    ['toggle-comments', 'comments', () => t('pages.cmd.comments')],
    ['speed-up', 'plus', () => t('pages.cmd.speedUp')],
    ['speed-down', 'minus', () => t('pages.cmd.speedDown')],
    ['speed-reset', 'speed', () => t('pages.cmd.speedReset')],
  ];

  const SUB_LANGS = [
    'en', 'az', 'tr', 'ru', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'uk', 'cs', 'sk', 'hu', 'ro', 'bg', 'el', 'sr', 'hr',
    'sv', 'no', 'da', 'fi', 'et', 'lv', 'lt', 'ka', 'hy', 'kk', 'uz', 'ar', 'fa', 'he', 'hi', 'bn', 'ur', 'id', 'ms',
    'vi', 'th', 'ja', 'ko', 'zh-Hans', 'zh-Hant',
  ];

  /** Example video for the live file-name preview (proper nouns, not UI text). */
  const SAMPLE_VIDEO = { title: 'Never Gonna Give You Up', id: 'dQw4w9WgXcQ', author: 'Rick Astley', date: '20091025' };

  const state = {
    section: 'general',
    host: null, // HostStatus
    hostLoading: false,
    hostFetchedAt: 0,
    hostPolls: 0,
    update: { running: false, result: null, error: null },
    picking: false,
    commands: null,
    commandsError: null,
  };

  /** Per-render registries (cleared whenever a section is rendered). */
  const bindings = new Map(); // setting name -> Set<fn(value)>
  const hostPainters = new Set(); // fns repainting companion-dependent UI
  const layoutPainters = new Set(); // fns that depend on element widths (run after rendering and on resize)
  let shortcutPainter = null;

  let navEl = null;
  let mainEl = null;
  let hostSeq = 0;
  let hostPollTimer = 0;
  let uid = 0;

  /* ================================================================== saved indicator */

  const saved = (() => {
    let el = null;
    let timer = 0;
    return {
      mount() {
        el = h('div', { class: 'op-saved', role: 'status', 'aria-live': 'polite' });
        document.body.appendChild(el);
      },
      show() {
        if (!el) return;
        clear(el);
        el.append(icon('check-circle', { size: 16 }), h('span', null, t('pages.saved')));
        el.classList.add('is-visible');
        clearTimeout(timer);
        timer = setTimeout(() => el.classList.remove('is-visible'), 1600);
      },
    };
  })();

  /* ================================================================== settings plumbing */

  function bind(name, fn) {
    if (!bindings.has(name)) bindings.set(name, new Set());
    bindings.get(name).add(fn);
  }

  function onSettings(changes) {
    if ('language' in changes) AYT.i18n.setLanguage(changes.language); // full re-render via i18n.onChange
    for (const [name, value] of Object.entries(changes)) {
      const set = bindings.get(name);
      if (!set) continue;
      for (const fn of Array.from(set)) {
        try {
          fn(value);
        } catch (e) {
          console.error('[AYT] options: binding failed', name, e);
        }
      }
    }
  }

  /** Validates + stores a setting; shows "Saved" or an error toast (and calls revert()). Resolves to the stored value or undefined. */
  async function save(name, value, revert) {
    try {
      const v = await P.saveSetting(name, value);
      saved.show();
      return v;
    } catch (e) {
      if (typeof revert === 'function') {
        try {
          revert();
        } catch (_) {
          /* ignore */
        }
      }
      ui.toast(e && e.code === 'invalid' ? t('pages.err.invalidValue') : t('pages.err.saveFailed', { message: P.errorText(e) }), { kind: 'error' });
      return undefined;
    }
  }

  /* ================================================================== building blocks */

  function card(o, ...children) {
    const opts = o || {};
    return h(
      'section',
      { class: ['op-card', opts.className], id: opts.id || null, dataset: opts.setting ? { setting: opts.setting } : null },
      opts.title
        ? h(
            'div',
            { class: 'op-card__head' },
            opts.icon ? h('div', { class: 'op-card__icon', 'aria-hidden': 'true' }, icon(opts.icon, { size: 18 })) : null,
            h('div', { class: 'op-card__titles' }, h('h2', { class: 'op-card__title' }, opts.title), opts.desc ? h('p', { class: 'op-card__desc' }, opts.desc) : null),
            opts.actions ? h('div', { class: 'op-card__actions' }, opts.actions) : null
          )
        : null,
      children.length ? h('div', { class: 'op-card__body' }, children) : null
    );
  }

  /**
   * Settings row: label + description on the left, control on the right (or below for stacked rows).
   * o: { label, desc, control, below, icon, kind, stack, setting, labelTarget, className, extra }
   */
  function row(o) {
    const id = 'op-r' + ++uid;
    const labelEl = h('div', { class: 'op-row__label', id: id + '-l' }, o.label);
    const descEl = o.desc ? h('div', { class: 'op-row__desc', id: id + '-d' }, o.desc) : null;
    const el = h(
      'div',
      { class: ['op-row', o.kind && 'op-row--' + o.kind, o.stack && 'op-row--stack', o.className], dataset: o.setting ? { setting: o.setting } : null },
      o.icon ? h('div', { class: 'op-row__icon', 'aria-hidden': 'true' }, typeof o.icon === 'string' ? icon(o.icon, { size: 18 }) : o.icon) : null,
      h('div', { class: 'op-row__text' }, labelEl, descEl, o.extra || null),
      o.control ? h('div', { class: 'op-row__control' }, o.control) : null,
      o.below ? h('div', { class: 'op-row__below' }, o.below) : null
    );
    const target = o.labelTarget;
    if (target) {
      target.setAttribute('aria-labelledby', labelEl.id);
      if (descEl) target.setAttribute('aria-describedby', descEl.id);
    }
    return el;
  }

  /** Clicking anywhere on a switch row (outside other controls) toggles the switch. */
  function rowToggle(rowEl, sw) {
    rowEl.addEventListener('click', (e) => {
      if (e.target.closest('.ayt-switch, a, button, select, input, textarea, summary, .op-row__below')) return;
      sw.input.click();
    });
  }

  function switchRow(name, label, desc, extraBelow) {
    const sw = ui.switchControl({ checked: !!S(name), onChange: (v) => save(name, v, () => (sw.checked = !v)) });
    sw.input.setAttribute('role', 'switch');
    sw.input.dataset.setting = name;
    bind(name, (v) => (sw.checked = !!v));
    const r = row({ label, desc, control: sw.el, kind: 'switch', setting: name, labelTarget: sw.input, below: extraBelow || null });
    rowToggle(r, sw);
    return r;
  }

  function segRow(name, label, desc, options, o) {
    const seg = ui.segmented({ options, value: S(name), ariaLabel: typeof label === 'string' ? label : name, onChange: (v) => save(name, v, () => (seg.value = S(name))) });
    seg.el.dataset.setting = name;
    bind(name, (v) => (seg.value = v));
    return row({ label, desc, control: seg.el, kind: 'seg', setting: name, labelTarget: seg.el, stack: o && o.stack });
  }

  function selectRow(name, label, desc, options, o) {
    const num = !!(o && o.number);
    const sel = ui.select({ options, value: S(name), onChange: (v) => save(name, num ? Number(v) : v, () => (sel.value = S(name))) });
    sel.select.dataset.setting = name;
    bind(name, (v) => (sel.value = v));
    return row({ label, desc, control: sel.el, kind: 'select', setting: name, labelTarget: sel.select, below: (o && o.below) || null });
  }

  function sliderRow(name, label, desc, o) {
    const sl = ui.slider({ min: o.min, max: o.max, step: o.step, value: S(name), format: o.format, onChange: (v) => save(name, v, () => (sl.value = S(name))) });
    sl.input.dataset.setting = name;
    bind(name, (v) => (sl.value = v));
    const r = row({ label, desc, control: sl.el, kind: 'slider', setting: name, labelTarget: sl.input });
    r._slider = sl;
    return r;
  }

  function radioRow(name, label, desc, options) {
    const rl = ui.radioList({ options, value: S(name), onChange: (v) => save(name, v, () => (rl.value = S(name))) });
    rl.el.dataset.setting = name;
    bind(name, (v) => (rl.value = v));
    return row({ label, desc, kind: 'radio', setting: name, labelTarget: rl.el, below: rl.el });
  }

  /**
   * Text setting committed on change/Enter/blur, validated with check(value) -> { ok, value, reason }.
   * o: { name, label, desc, placeholder(), check, errorText(reason), buttons: [] , mono }
   */
  function textRow(o) {
    const input = h('input', {
      type: 'text',
      class: ['ayt-input', 'op-text', o.mono && 'op-text--mono'],
      spellcheck: false,
      autocomplete: 'off',
      value: S(o.name) || '',
      placeholder: o.placeholder ? o.placeholder() : null,
      dataset: { setting: o.name },
    });
    const err = h('div', { class: 'op-field-error', role: 'alert' });
    const showError = (msg) => {
      input.classList.toggle('is-invalid', !!msg);
      input.setAttribute('aria-invalid', msg ? 'true' : 'false');
      err.textContent = msg || '';
    };
    // A value saved before the current rules (e.g. a folder the companion now refuses) is flagged right away.
    const checkStored = () => {
      const cur = S(o.name) || '';
      const r = cur ? o.check(cur) : { ok: true };
      showError(r.ok ? '' : o.errorText(r.reason));
    };
    let committing = false;
    const commit = async () => {
      if (committing) return;
      const r = o.check(input.value);
      if (!r.ok) {
        showError(o.errorText(r.reason));
        return;
      }
      showError('');
      if (r.value === S(o.name)) {
        input.value = r.value;
        return;
      }
      committing = true;
      const v = await save(o.name, r.value);
      committing = false;
      if (v !== undefined) input.value = v;
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        input.value = S(o.name) || '';
        checkStored();
      }
    });
    bind(o.name, (v) => {
      if (document.activeElement !== input) {
        input.value = v || '';
        checkStored();
      }
    });
    const line = h('div', { class: 'op-text-line' }, input, o.buttons || null);
    const r = row({ label: o.label, desc: o.desc, kind: 'text', setting: o.name, labelTarget: input, below: h('div', { class: 'op-text-wrap' }, line, err, o.after || null) });
    r._input = input;
    checkStored();
    return r;
  }

  function busy(btn, isBusy, label) {
    btn.disabled = !!isBusy || btn.disabled;
    btn.classList.toggle('is-busy', !!isBusy);
    if (isBusy) {
      const first = btn.firstChild;
      if (first && first.nodeName.toLowerCase() === 'svg') btn.replaceChild(ui.spinner(), first);
      if (label) {
        const span = btn.querySelector('span:not(.ayt-spinner)');
        if (span) span.textContent = label;
      }
    }
    return btn;
  }

  function formatTime(ms) {
    try {
      return new Intl.DateTimeFormat(AYT.i18n.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ms));
    } catch (_) {
      return new Date(ms).toLocaleTimeString();
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      ui.toast(t('common.copied'), { kind: 'success' });
    } catch (_) {
      ui.toast(t('pages.err.copyFailed'), { kind: 'error' });
    }
  }

  let measureCtx = null;

  /** Does `text` fit into an <input> (in its font, without padding)? null when it can't be measured (not laid out). */
  function fitsInput(input, text) {
    try {
      if (!input.isConnected || !input.clientWidth) return null;
      const cs = getComputedStyle(input);
      measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
      measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const room = input.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      return measureCtx.measureText(text).width <= room;
    } catch (_) {
      return null;
    }
  }

  function runLayoutPainters() {
    for (const fn of Array.from(layoutPainters)) {
      try {
        fn();
      } catch (e) {
        console.error('[AYT] options: layout update failed', e);
      }
    }
  }

  /** "C:\Users\akifr\AppData\Local\AkifYouTubeAddon\bin\yt-dlp.exe" -> "C:\…\bin\yt-dlp.exe" (full path in the tooltip). */
  function shortPath(p) {
    const s = String(p || '');
    const sep = s.includes('\\') || !s.includes('/') ? '\\' : '/';
    const unc = /^[\\/]{2}/.test(s);
    const parts = s.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 3) return s;
    return (unc ? sep + sep : '') + parts[0] + sep + '…' + sep + parts.slice(-2).join(sep);
  }

  /* ================================================================== routing + layout */

  function sectionFromHash() {
    let raw = '';
    try {
      raw = decodeURIComponent((location.hash || '').replace(/^#\/?/, '')).trim().toLowerCase();
    } catch (_) {
      raw = '';
    }
    const id = ALIASES[raw] || raw;
    const sec = SECTIONS.find((s) => s.id === id && !(s.hidden && s.hidden()));
    return sec ? sec.id : 'general';
  }

  function onHashChange() {
    const id = sectionFromHash();
    if (id === state.section) return;
    state.section = id;
    renderNav();
    renderSection(true);
  }

  function render() {
    clear(app);
    // Keyboard users can jump over the navigation (a button: a #fragment link would trigger the hash router).
    const skip = h(
      'button',
      {
        type: 'button',
        class: 'op-skip',
        on: {
          click: () => {
            const title = mainEl && mainEl.querySelector('.op-head__title');
            if (title) title.focus();
          },
        },
      },
      t('pages.skipToContent')
    );
    navEl = h('aside', { class: 'op-nav' });
    mainEl = h('main', { class: 'op-main', id: 'op-main' });
    app.append(skip, navEl, mainEl);
    renderNav();
    renderSection(false);
  }

  function navHostStatus() {
    const view = P.hostView(state.host || { state: 'checking' });
    return h('span', { class: 'op-nav__status' }, h('span', { class: ['op-nav__dot', 'op-nav__dot--' + view.tone], 'aria-hidden': 'true', title: view.pill }), h('span', { class: 'ayt-sr' }, view.pill));
  }

  function renderNav() {
    if (!navEl) return;
    clear(navEl);
    const version = P.extVersion();
    const list = h('nav', { class: 'op-nav__list', 'aria-label': t('pages.nav.label') });
    for (const s of SECTIONS) {
      if (s.hidden && s.hidden()) continue;
      const active = s.id === state.section;
      // title: the label is cut off with an ellipsis in narrower windows (the 232 px column at 781–980 px)
      const a = h(
        'a',
        { class: ['op-nav__item', active && 'is-active'], href: '#' + s.id, title: s.title(), 'aria-current': active ? 'page' : null, dataset: { section: s.id } },
        icon(s.icon, { size: 18 }),
        h('span', { class: 'op-nav__label' }, s.title()),
        s.id === 'companion' ? navHostStatus() : null
      );
      list.appendChild(a);
    }
    // The aside is a full-height column (background); the inner block sticks to the top while the page scrolls.
    navEl.appendChild(
      h(
        'div',
        { class: 'op-nav__inner' },
        h(
          'div',
          { class: 'op-brand' },
          h('img', { class: 'op-brand__logo', src: '../icons/icon.svg', alt: '', width: 36, height: 36, draggable: false }),
          h('div', { class: 'op-brand__text' }, h('div', { class: 'op-brand__name' }, "Akif's Special YouTube Addon"), h('div', { class: 'op-brand__ver' }, t('pages.versionLabel', { version })))
        ),
        list
      )
    );
    // Narrow windows show the sections as one scrolling row of chips: a plain mouse wheel scrolls it sideways, and
    // edge fades (has-more-start / has-more-end, options.css) show that more sections are hidden to the side.
    list.addEventListener(
      'wheel',
      (e) => {
        const max = list.scrollWidth - list.clientWidth;
        if (max <= 1 || e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; // column layout, zoom, or already sideways
        const step = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * list.clientWidth : e.deltaY;
        const next = Math.max(0, Math.min(max, list.scrollLeft + step));
        if (next === list.scrollLeft) return; // at the end: the page scrolls as usual
        list.scrollLeft = next;
        e.preventDefault();
      },
      { passive: false }
    );
    list.addEventListener('scroll', updateNavFade, { passive: true });
    const activeLink = list.querySelector('.is-active');
    if (activeLink && typeof activeLink.scrollIntoView === 'function' && list.scrollWidth > list.clientWidth) {
      // centered, so that the neighbours on both sides stay (partly) visible
      activeLink.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    updateNavFade();
  }

  function updateNavFade() {
    const list = navEl && navEl.querySelector('.op-nav__list');
    if (!list) return;
    const max = list.scrollWidth - list.clientWidth;
    list.classList.toggle('has-more-start', max > 1 && list.scrollLeft > 1);
    list.classList.toggle('has-more-end', max > 1 && list.scrollLeft < max - 1);
  }

  function renderSection(focus) {
    const sec = SECTIONS.find((s) => s.id === state.section && !(s.hidden && s.hidden())) || SECTIONS[0];
    state.section = sec.id;
    bindings.clear();
    hostPainters.clear();
    layoutPainters.clear();
    shortcutPainter = null;
    clear(mainEl);
    const title = h('h1', { class: 'op-head__title', tabindex: '-1' }, sec.title());
    const body = h('div', { class: 'op-body', dataset: { section: sec.id } });
    mainEl.append(h('header', { class: 'op-head' }, title, h('p', { class: 'op-head__desc' }, sec.desc())), body);
    try {
      sec.render(body);
    } catch (e) {
      console.error('[AYT] options: section failed', sec.id, e);
      body.appendChild(ui.notice({ kind: 'error', title: t('common.error'), text: t('error.generic', { message: (e && e.message) || String(e) }) }));
    }
    document.title = t('pages.docTitle', { section: sec.title() });
    runLayoutPainters(); // the section is in the document now: widths can be measured
    if (focus) {
      window.scrollTo(0, 0);
      try {
        title.focus({ preventScroll: true });
      } catch (_) {
        /* ignore */
      }
    }
  }

  /* ================================================================== companion status */

  function repaintHost() {
    for (const fn of Array.from(hostPainters)) {
      try {
        fn();
      } catch (e) {
        console.error('[AYT] options: repaint failed', e);
      }
    }
    const old = navEl && navEl.querySelector('.op-nav__item[data-section="companion"] .op-nav__status');
    if (old) old.replaceWith(navHostStatus());
  }

  async function loadHost(force) {
    const seq = ++hostSeq;
    state.hostLoading = true;
    repaintHost();
    const st = await P.fetchHostStatus(force); // never throws
    if (seq !== hostSeq) return;
    state.hostLoading = false;
    state.host = st;
    state.hostFetchedAt = Date.now();
    repaintHost();
    scheduleHostPoll();
  }

  /** The service worker may answer 'checking' while it talks to the companion: ask again shortly. */
  function scheduleHostPoll() {
    clearTimeout(hostPollTimer);
    if (!state.host || state.host.state !== 'checking') {
      state.hostPolls = 0;
      return;
    }
    if (state.hostPolls >= 15) {
      state.hostPolls = 0;
      state.host = { state: 'unknown', error: t('pages.err.timeout') };
      repaintHost();
      return;
    }
    hostPollTimer = setTimeout(() => {
      state.hostPolls++;
      loadHost(false);
    }, 1500);
  }

  const isConnected = () => !!(state.host && state.host.state === 'connected');

  /* ================================================================== sections */

  /* ---------------------------------------------------------------- General */
  function renderGeneral(body) {
    const langOptions = P.languageOptions();
    const lang = ui.select({ options: langOptions, value: S('language'), onChange: (v) => save('language', v, () => (lang.value = S('language'))) });
    P.applyOptionLangs(lang.select, langOptions);
    lang.select.dataset.setting = 'language';
    bind('language', (v) => (lang.value = v));
    body.append(
      card(
        { title: t('pages.general.appearance'), icon: 'globe' },
        row({ label: t('common.language'), desc: t('pages.general.languageDesc'), control: lang.el, kind: 'select', setting: 'language', labelTarget: lang.select }),
        segRow('theme', t('pages.general.theme'), t('pages.general.themeDesc'), [
          { value: 'auto', label: t('common.auto'), icon: 'contrast' },
          { value: 'dark', label: t('pages.general.themeDark'), icon: 'moon' },
          { value: 'light', label: t('pages.general.themeLight'), icon: 'sun' },
        ])
      ),
      renderToolbarCard(),
      card(
        { title: t('pages.general.shortsTitle'), icon: 'phone' },
        switchRow('showOnShorts', t('pages.general.showOnShorts'), t('pages.general.showOnShortsDesc')),
        switchRow('shortsToWatch', t('pages.general.shortsToWatch'), t('pages.general.shortsToWatchDesc'))
      )
    );
  }

  function renderToolbarCard() {
    const hiddenSet = () => new Set(S('toolbarHidden') || []);
    const preview = h('div', { class: 'op-tb-preview', 'aria-hidden': 'true' });
    const paintPreview = () => {
      clear(preview);
      const hidden = hiddenSet();
      preview.appendChild(h('span', { class: 'op-tb-preview__brand' }, icon('logo', { size: 22 })));
      let last = null;
      let shown = 0;
      for (const b of P.TOOLBAR_BUTTONS) {
        if (hidden.has(b.id)) continue;
        if (last && b.group !== last) preview.appendChild(h('span', { class: 'op-tb-preview__sep' }));
        last = b.group;
        preview.appendChild(h('span', { class: 'op-tb-preview__btn', title: P.toolbarLabel(b.id) }, icon(b.icon, { size: 20 })));
        shown++;
      }
      if (!shown) preview.appendChild(h('span', { class: 'op-tb-preview__empty' }, t('pages.toolbar.allHidden')));
    };
    paintPreview();
    bind('toolbarHidden', paintPreview);

    const showAll = ui.button({ label: t('pages.toolbar.showAll'), icon: 'eye', size: 'sm', onClick: () => save('toolbarHidden', []) });
    showAll.dataset.action = 'toolbar-show-all';
    const syncShowAll = () => (showAll.disabled = !(S('toolbarHidden') || []).length);
    syncShowAll();
    bind('toolbarHidden', syncShowAll);

    const groups = [
      ['download', t('pages.toolbar.groupDownload')],
      ['tools', t('pages.toolbar.groupTools')],
      ['end', t('pages.toolbar.groupOther')],
    ];
    const list = h('div', { class: 'op-tb-list' });
    for (const [gid, gname] of groups) {
      list.appendChild(h('div', { class: 'op-subhead' }, gname));
      for (const b of P.TOOLBAR_BUTTONS.filter((x) => x.group === gid)) {
        const sw = ui.switchControl({ checked: !hiddenSet().has(b.id), onChange: (on) => setToolbarVisible(b.id, on, sw) });
        sw.input.setAttribute('role', 'switch');
        sw.input.dataset.button = b.id;
        bind('toolbarHidden', (arr) => (sw.checked = !(arr || []).includes(b.id)));
        const r = row({ icon: b.icon, label: P.toolbarLabel(b.id), control: sw.el, kind: 'switch', className: 'op-row--compact', labelTarget: sw.input });
        r.dataset.button = b.id;
        rowToggle(r, sw);
        list.appendChild(r);
      }
    }
    return card(
      { title: t('pages.toolbar.title'), desc: t('pages.toolbar.desc'), icon: 'sliders', actions: showAll, setting: 'toolbarHidden' },
      h('div', { class: 'op-tb-preview-wrap' }, preview),
      list
    );
  }

  function setToolbarVisible(id, visible, sw) {
    const hidden = new Set(S('toolbarHidden') || []);
    if (visible) hidden.delete(id);
    else hidden.add(id);
    const order = P.TOOLBAR_BUTTONS.map((b) => b.id);
    const rank = (x) => (order.indexOf(x) === -1 ? 999 : order.indexOf(x));
    const next = Array.from(hidden).sort((a, b) => rank(a) - rank(b));
    return save('toolbarHidden', next, () => (sw.checked = !visible));
  }

  /* ---------------------------------------------------------------- Companion */
  function renderCompanion(body) {
    const statusBox = h('div', { class: 'op-status-wrap' });
    const updateBox = h('div', { class: 'op-update-wrap' });
    const paint = () => {
      paintStatus(statusBox);
      paintUpdate(updateBox);
    };
    hostPainters.add(paint);
    bind('outputDir', paint); // "Downloads are saved to" follows the folder settings
    bind('subfolder', paint);
    paint();
    body.append(card({ className: 'op-card--status' }, statusBox, updateBox), renderInstallGuide(), renderTroubleshooting(), renderTechInfo());
    // Refresh when the section opens (forced when the last answer was not "connected": maybe the user just installed).
    const stale = Date.now() - state.hostFetchedAt > 10000;
    if (!state.hostLoading && (stale || !state.host)) loadHost(!!state.host && !isConnected());
  }

  function paintStatus(box) {
    clear(box);
    const st = state.host;
    const view = P.hostView(st || { state: 'checking' });
    const working = state.hostLoading || view.state === 'checking';
    const recheck = busy(ui.button({ label: t('host.checkAgain'), icon: 'refresh', size: 'sm', disabled: working, onClick: () => loadHost(true) }), working);
    recheck.dataset.action = 'recheck';
    const tone = st ? view.tone : 'busy';
    box.appendChild(
      h(
        'div',
        { class: ['op-status', 'op-status--' + tone], dataset: { state: st ? st.state : 'checking' } },
        h('div', { class: 'op-status__icon', 'aria-hidden': 'true' }, !st || view.state === 'checking' ? ui.spinner() : icon(view.icon, { size: 26 })),
        h(
          'div',
          { class: 'op-status__body' },
          h('div', { class: 'op-status__title', role: 'status' }, view.title),
          view.text ? h('div', { class: 'op-status__text' }, view.text) : null,
          st && st.state === 'unknown' && st.error ? h('div', { class: 'op-status__detail' }, String(st.error)) : null,
          st && (st.state === 'error' || st.state === 'forbidden') && typeof st.detail === 'string' && st.detail && st.detail !== st.error
            ? h('code', { class: 'op-status__raw', title: st.detail }, st.detail.slice(0, 300))
            : null,
          st && st.checkedAt ? h('div', { class: 'op-status__time' }, t('pages.companion.checkedAt', { time: formatTime(st.checkedAt) })) : null
        ),
        h('div', { class: 'op-status__actions' }, recheck)
      )
    );
    if (st && st.state === 'connected') box.appendChild(renderHostDetails(st));
  }

  function renderHostDetails(st) {
    const tools = st.tools && typeof st.tools === 'object' ? st.tools : {};
    const tool = (k) => (tools[k] && typeof tools[k] === 'object' ? tools[k] : {});
    const tiles = [
      { name: t('pages.companion.app'), icon: 'plug', version: st.version, path: null, extra: st.protocol != null ? t('pages.companion.protocol', { version: st.protocol }) : null },
      { name: 'yt-dlp', icon: 'download', version: tool('ytdlp').version, path: tool('ytdlp').path },
      { name: 'FFmpeg', icon: 'film', version: tool('ffmpeg').version, path: tool('ffmpeg').path },
      { name: 'Deno', icon: 'sparkle', version: tool('deno').version, path: tool('deno').path },
    ];
    const grid = h(
      'div',
      { class: 'op-tools' },
      tiles.map((x) =>
        h(
          'div',
          { class: 'op-tool' },
          h('div', { class: 'op-tool__head' }, icon(x.icon, { size: 16 }), h('span', null, x.name)),
          h('div', { class: 'op-tool__ver', title: x.version ? String(x.version) : '' }, x.version ? String(x.version) : t('common.unknown')),
          x.path ? h('div', { class: 'op-tool__path', title: String(x.path) }, shortPath(x.path)) : x.extra ? h('div', { class: 'op-tool__path' }, x.extra) : null
        )
      )
    );
    const folder = P.effectiveFolder(AYT.settings.all(), st) || st.defaultDir;
    return h(
      'div',
      { class: 'op-host-details' },
      grid,
      folder
        ? h(
            'div',
            { class: 'op-folder' },
            icon('folder', { size: 18 }),
            h('div', { class: 'op-folder__text' }, h('div', { class: 'op-folder__label' }, t('pages.companion.saveFolder')), h('div', { class: 'op-folder__path', title: String(folder) }, String(folder))),
            ui.button({ label: t('pages.companion.changeFolder'), size: 'sm', variant: 'ghost', onClick: () => (location.hash = '#downloads') })
          )
        : null
    );
  }

  function paintUpdate(box) {
    clear(box);
    const connected = isConnected();
    const u = state.update;
    const btn = busy(
      ui.button({ label: u.running ? t('pages.companion.updating') : t('pages.companion.update'), icon: 'refresh', size: 'sm', disabled: !connected || u.running, onClick: runUpdate }),
      u.running
    );
    btn.dataset.action = 'update-tools';
    box.appendChild(
      h(
        'div',
        { class: 'op-update' },
        h('div', { class: 'op-update__text' }, h('div', { class: 'op-row__label' }, t('pages.companion.updateTitle')), h('div', { class: 'op-row__desc' }, connected ? t('pages.companion.updateDesc') : t('pages.companion.updateNeedsHost'))),
        btn
      )
    );
    if (u.running) {
      box.appendChild(ui.notice({ kind: 'info', icon: 'clock', text: t('pages.companion.updateRunning') }));
    } else if (u.error) {
      const unsupported = u.error.code === 'unsupported';
      if (unsupported) box.appendChild(ui.notice({ kind: 'warn', title: t('pages.companion.updateUnsupportedTitle'), text: t('pages.companion.updateUnsupported') }));
      // busy: downloads are running or another update is in progress (the text says so): not a failure
      else if (u.error.code === 'busy') box.appendChild(ui.notice({ kind: 'warn', text: u.error.message }));
      else box.appendChild(ui.notice({ kind: 'error', title: t('pages.companion.updateFailed'), text: u.error.message }));
    } else if (u.result && connected) {
      // (a result is stale once the companion is gone, so it is only shown while connected)
      const r = u.result;
      const str = (x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '');
      const before = str(r.before);
      const after = str(r.after) || str(r.version);
      let text = t('pages.companion.updateDone');
      if (before && after && before !== after) text = t('pages.companion.updated', { before, after });
      else if (after || before) text = t('pages.companion.upToDate', { version: after || before });
      box.appendChild(ui.notice({ kind: 'success', text }));
      if (str(r.output)) {
        const details = h('details', { class: 'op-output', open: !!u.outputOpen }, h('summary', null, t('pages.companion.showOutput')), h('pre', null, str(r.output).slice(-20000)));
        details.addEventListener('toggle', () => (u.outputOpen = details.open)); // survives repaints
        box.appendChild(details);
      }
    }
  }

  async function runUpdate() {
    if (state.update.running) return;
    state.update = { running: true, result: null, error: null };
    repaintHost();
    try {
      const res = await P.request(AYT.MSG.HOST_UPDATE_TOOLS, {}, P.TIMEOUTS.updateTools);
      state.update = { running: false, result: res || {}, error: null };
      loadHost(true);
    } catch (e) {
      state.update = { running: false, result: null, error: { code: e && e.code, message: P.errorText(e) } };
    }
    repaintHost();
  }

  /** Install guide: expanded while the companion is not usable, collapsed when connected (until the user toggles it). */
  function renderInstallGuide() {
    const steps = [
      [t('pages.install.step1Title'), t('pages.install.step1Text')],
      [t('pages.install.step2Title'), t('pages.install.step2Text')],
      [t('pages.install.step3Title'), t('pages.install.step3Text')],
    ];
    const recheck = ui.button({ label: t('host.checkAgain'), icon: 'refresh', size: 'sm', variant: 'primary', onClick: () => loadHost(true) });
    const syncRecheck = () => (recheck.disabled = state.hostLoading);
    hostPainters.add(syncRecheck);
    syncRecheck();
    const list = h(
      'ol',
      { class: 'op-steps' },
      steps.map(([title, text], i) =>
        h(
          'li',
          { class: 'op-step' },
          h('span', { class: 'op-step__num', 'aria-hidden': 'true' }, String(i + 1)),
          h('div', { class: 'op-step__body' }, h('div', { class: 'op-step__title' }, title), h('div', { class: 'op-step__text' }, text), i === 2 ? h('div', { class: 'op-step__action' }, recheck) : null)
        )
      )
    );
    const wantOpen = () => !!state.host && state.host.state !== 'connected' && state.host.state !== 'checking';
    let expected = wantOpen();
    let auto = true; // follows the companion status until the user opens/closes it
    const details = h(
      'details',
      { class: 'op-guide', open: expected },
      h('summary', { class: 'op-guide__summary' }, icon('chevron-right', { size: 18, className: 'op-guide__chev' }), h('span', null, t('pages.install.title'))),
      h('div', { class: 'op-guide__body' }, h('p', { class: 'op-card__desc' }, t('pages.install.desc')), list, h('div', { class: 'op-note' }, icon('info', { size: 16 }), h('span', null, t('pages.install.note'))))
    );
    // 'toggle' fires asynchronously for our own changes too: only a state we did not set means a user action.
    details.addEventListener('toggle', () => {
      if (details.open !== expected) auto = false;
    });
    hostPainters.add(() => {
      if (!auto || state.hostLoading) return;
      expected = wantOpen();
      if (details.open !== expected) details.open = expected;
    });
    return card({ id: 'install', className: 'op-card--guide' }, details);
  }

  function renderTroubleshooting() {
    const tips = [
      t('pages.trouble.restart'),
      t('pages.trouble.smartscreen'),
      t('pages.trouble.moved'),
      t('pages.trouble.bot'),
      t('pages.trouble.update'),
      t('pages.trouble.uninstall'),
    ];
    return card({ title: t('pages.trouble.title'), icon: 'help' }, h('ul', { class: 'op-tips' }, tips.map((x) => h('li', null, x))));
  }

  function renderTechInfo() {
    const copyRow = (label, value, action) => {
      const btn = ui.button({ icon: 'copy', size: 'sm', variant: 'ghost', title: t('common.copy'), onClick: () => copyText(value) });
      btn.dataset.action = action;
      return row({ label, extra: h('code', { class: 'op-code' }, value), control: btn, kind: 'copy' });
    };
    return card(
      { title: t('pages.companion.techTitle'), desc: t('pages.companion.techDesc'), icon: 'info' },
      copyRow(t('pages.companion.extensionId'), chrome.runtime.id, 'copy-id'),
      copyRow(t('pages.companion.hostName'), AYT.HOST_NAME, 'copy-host')
    );
  }

  /* ---------------------------------------------------------------- Downloads */
  function folderPlaceholder() {
    const f = P.effectiveFolder(Object.assign({}, AYT.settings.all(), { outputDir: '' }), state.host);
    if (f) return t('pages.downloads.defaultIs', { path: f });
    const sub = S('subfolder');
    return sub ? t('pages.downloads.defaultSub', { subfolder: sub }) : t('pages.downloads.defaultRoot');
  }

  function dirError(reason) {
    if (reason === 'long') return t('pages.downloads.errDirLong', { max: P.MAX_OUTPUT_DIR });
    if (reason === 'chars') return t('pages.downloads.errChars');
    if (reason === 'name') return t('pages.downloads.errName');
    if (reason === 'relative') return t('pages.downloads.errRelative');
    return t('pages.downloads.errAbsolute');
  }

  async function pickFolder() {
    if (state.picking || !isConnected()) return;
    state.picking = true;
    repaintHost();
    try {
      const res = await P.request(AYT.MSG.HOST_PICK_FOLDER, {}, P.TIMEOUTS.pickFolder);
      const path = res && typeof res.path === 'string' ? res.path : null;
      if (path) {
        const r = P.checkOutputDir(path);
        if (r.ok) await save('outputDir', r.value);
        else ui.toast(dirError(r.reason), { kind: 'error' });
      }
    } catch (e) {
      ui.toast(P.errorText(e), { kind: 'error' });
    } finally {
      state.picking = false;
      repaintHost();
    }
  }

  function outputDirRow() {
    const choose = ui.button({ label: t('pages.downloads.choose'), icon: 'folder', size: 'sm', onClick: pickFolder });
    choose.dataset.action = 'pick-folder';
    const useDefault = ui.button({ label: t('pages.downloads.useDefault'), size: 'sm', variant: 'ghost', onClick: () => save('outputDir', '') });
    useDefault.dataset.action = 'default-folder';
    // The default folder is the placeholder; when the field is too narrow to show it whole, it is repeated below.
    const defaultHint = h('div', { class: ['op-hint', 'op-hint--path', 'ayt-hidden'] });
    const hint = h('div', { class: 'op-hint' });
    const r = textRow({
      name: 'outputDir',
      label: t('pages.downloads.outputDir'),
      desc: t('pages.downloads.outputDirDesc'),
      placeholder: folderPlaceholder,
      check: P.checkOutputDir,
      errorText: dirError,
      mono: true,
      buttons: [choose, useDefault],
      after: [defaultHint, hint],
    });
    const fitDefault = () => {
      const placeholder = r._input.placeholder;
      const fits = S('outputDir') ? true : fitsInput(r._input, placeholder);
      if (fits === null) return; // not laid out yet: runLayoutPainters() measures again
      defaultHint.textContent = fits ? '' : placeholder;
      defaultHint.classList.toggle('ayt-hidden', fits);
    };
    const sync = () => {
      const connected = isConnected();
      choose.disabled = !connected || state.picking;
      const span = choose.querySelector('span');
      if (span) span.textContent = state.picking ? t('pages.downloads.choosing') : t('pages.downloads.choose');
      useDefault.disabled = !S('outputDir');
      const placeholder = folderPlaceholder();
      r._input.placeholder = placeholder;
      r._input.title = S('outputDir') || placeholder; // the whole path, also when the field cuts it off
      hint.textContent = connected ? '' : t('pages.downloads.chooseNeedsHost');
      hint.classList.toggle('ayt-hidden', connected);
      fitDefault();
    };
    hostPainters.add(sync);
    layoutPainters.add(fitDefault);
    bind('outputDir', sync);
    bind('subfolder', sync);
    sync();
    return r;
  }

  function subfolderRow() {
    return textRow({
      name: 'subfolder',
      label: t('pages.downloads.subfolder'),
      desc: t('pages.downloads.subfolderDesc'),
      placeholder: () => t('pages.downloads.subfolderNone'),
      check: P.checkSubfolder,
      errorText: (reason) => (reason === 'long' ? t('pages.downloads.errLong') : reason === 'relative' ? t('pages.downloads.errRelative') : t('pages.downloads.errChars')),
    });
  }

  function filenameRow() {
    const example = h('div', { class: 'op-example' });
    const paint = () => {
      clear(example);
      example.append(h('span', { class: 'op-example__label' }, t('pages.downloads.example')), h('code', { class: 'op-code' }, U.buildFilename(S('filenameStyle'), SAMPLE_VIDEO, 'mp4', '1080p')));
    };
    paint();
    bind('filenameStyle', paint);
    return selectRow(
      'filenameStyle',
      t('pages.downloads.filename'),
      t('pages.downloads.filenameDesc'),
      [
        { value: 'title', label: t('pages.downloads.fnTitle') },
        { value: 'title_id', label: t('pages.downloads.fnTitleId') },
        { value: 'channel_title', label: t('pages.downloads.fnChannelTitle') },
        { value: 'date_title', label: t('pages.downloads.fnDateTitle') },
      ],
      { below: example }
    );
  }

  function bitrateLabel(b) {
    switch (b) {
      case 320:
        return t('pages.downloads.kbpsBest', { bitrate: b });
      case 192:
        return t('pages.downloads.kbpsRecommended', { bitrate: b });
      case 128:
        return t('pages.downloads.kbpsStandard', { bitrate: b });
      case 64:
        return t('pages.downloads.kbpsSmallest', { bitrate: b });
      default:
        return t('pages.downloads.kbps', { bitrate: b });
    }
  }

  function renderDownloads(body) {
    const cookies = switchRow('useCookies', t('pages.downloads.cookies'), t('pages.downloads.cookiesDesc'), ui.notice({ kind: 'warn', title: t('pages.downloads.cookiesWarnTitle'), text: t('pages.downloads.cookiesWarn') }));
    body.append(
      card({ title: t('pages.downloads.locationTitle'), icon: 'folder' }, outputDirRow(), subfolderRow(), filenameRow(), switchRow('askWhereToSave', t('pages.downloads.askWhere'), t('pages.downloads.askWhereDesc'))),
      card(
        { title: t('pages.downloads.videoTitle'), icon: 'video' },
        segRow('videoContainer', t('pages.downloads.container'), t('pages.downloads.containerDesc'), [
          { value: 'mp4', label: 'MP4' },
          { value: 'mkv', label: 'MKV' },
          { value: 'webm', label: 'WebM' },
        ]),
        radioRow('videoCodec', t('pages.downloads.codec'), t('pages.downloads.codecDesc'), [
          { value: 'auto', label: t('pages.downloads.codecAuto'), desc: t('pages.downloads.codecAutoDesc') },
          { value: 'compat', label: t('pages.downloads.codecCompat'), desc: t('pages.downloads.codecCompatDesc') },
        ])
      ),
      card(
        { title: t('pages.downloads.audioTitle'), icon: 'music' },
        segRow(
          'audioFormat',
          t('pages.downloads.audioFormat'),
          t('pages.downloads.audioFormatDesc'),
          ['mp3', 'm4a', 'opus', 'flac', 'wav'].map((value) => ({ value, label: P.audioFormatLabel(value) }))
        ),
        selectRow('audioBitrate', t('pages.downloads.bitrate'), t('pages.downloads.bitrateDesc'), AYT.MP3_BITRATES.map((b) => ({ value: b, label: bitrateLabel(b) })), { number: true })
      ),
      card(
        { title: t('pages.downloads.embedTitle'), desc: t('pages.downloads.embedDesc'), icon: 'file' },
        switchRow('embedThumbnail', t('pages.downloads.embedThumbnail'), t('pages.downloads.embedThumbnailDesc')),
        switchRow('embedMetadata', t('pages.downloads.embedMetadata'), t('pages.downloads.embedMetadataDesc')),
        switchRow('embedChapters', t('pages.downloads.embedChapters'), t('pages.downloads.embedChaptersDesc')),
        switchRow('embedSubtitles', t('pages.downloads.embedSubtitles'), t('pages.downloads.embedSubtitlesDesc'))
      ),
      card(
        { title: t('pages.downloads.behaviorTitle'), icon: 'settings' },
        segRow('maxConcurrent', t('pages.downloads.maxConcurrent'), t('pages.downloads.maxConcurrentDesc'), [1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))),
        switchRow('notifyOnComplete', t('pages.downloads.notify'), t('pages.downloads.notifyDesc')),
        cookies
      )
    );
  }

  /* ---------------------------------------------------------------- Screenshots */
  function renderScreenshots(body) {
    const quality = sliderRow('screenshotQuality', t('pages.shots.quality'), t('pages.shots.qualityDesc'), { min: 0.5, max: 1, step: 0.01, format: (v) => P.formatPercent(v) });
    const syncQuality = () => {
      const lossless = S('screenshotFormat') === 'png';
      quality.classList.toggle('is-disabled', lossless);
      quality._slider.input.disabled = lossless;
      const desc = quality.querySelector('.op-row__desc');
      if (desc) desc.textContent = lossless ? t('pages.shots.qualityPng') : t('pages.shots.qualityDesc');
    };
    syncQuality();
    bind('screenshotFormat', syncQuality);
    body.append(
      card(
        { title: t('pages.shots.title'), icon: 'camera' },
        segRow('screenshotFormat', t('pages.shots.format'), t('pages.shots.formatDesc'), [
          { value: 'png', label: 'PNG' },
          { value: 'jpg', label: 'JPG' },
          { value: 'webp', label: 'WebP' },
        ]),
        quality,
        radioRow('screenshotAction', t('pages.shots.action'), t('pages.shots.actionDesc'), [
          { value: 'save', label: t('pages.shots.save'), desc: t('pages.shots.saveDesc') },
          { value: 'copy', label: t('pages.shots.copy'), desc: t('pages.shots.copyDesc') },
          { value: 'both', label: t('pages.shots.both'), desc: t('pages.shots.bothDesc') },
        ])
      ),
      h('div', { class: 'op-tip' }, ui.notice({ kind: 'info', icon: 'sparkle', text: t('pages.shots.tip') }))
    );
  }

  /* ---------------------------------------------------------------- Thumbnails & subtitles */
  function subLangRow() {
    const current = S('subtitleLang');
    const codes = SUB_LANGS.slice();
    if (current && !codes.includes(current)) codes.push(current);
    const lang = AYT.i18n.language;
    const items = codes
      .map((c) => ({ value: c, label: P.displayLanguage(c) }))
      .sort((a, b) => a.label.localeCompare(b.label, lang));
    return selectRow('subtitleLang', t('pages.media.subLang'), t('pages.media.subLangDesc'), [{ value: '', label: t('pages.media.subLangAuto') }].concat(items));
  }

  function renderMedia(body) {
    body.append(
      card(
        { title: t('pages.media.thumbTitle'), icon: 'image' },
        segRow('thumbnailFormat', t('pages.media.thumbFormat'), t('pages.media.thumbFormatDesc'), [
          { value: 'original', label: t('pages.media.original') },
          { value: 'jpg', label: 'JPG' },
          { value: 'png', label: 'PNG' },
          { value: 'webp', label: 'WebP' },
        ])
      ),
      card(
        { title: t('pages.media.subTitle'), icon: 'cc' },
        radioRow('subtitleFormat', t('pages.media.subFormat'), t('pages.media.subFormatDesc'), [
          { value: 'srt', label: 'SRT', desc: t('pages.media.srtDesc') },
          { value: 'vtt', label: 'WebVTT', desc: t('pages.media.vttDesc') },
          { value: 'ttml', label: 'TTML', desc: t('pages.media.ttmlDesc') },
          { value: 'srv3', label: 'SRV3', desc: t('pages.media.srv3Desc') },
          { value: 'txt', label: t('pages.media.txt'), desc: t('pages.media.txtDesc') },
        ]),
        subLangRow()
      )
    );
  }

  /* ---------------------------------------------------------------- Player */
  function renderPlayer(body) {
    body.append(
      card(
        { title: t('pages.player.playbackTitle'), icon: 'play' },
        selectRow('autoQuality', t('pages.player.autoQuality'), t('pages.player.autoQualityDesc'), [
          { value: 'off', label: t('common.off') },
          { value: 'max', label: t('pages.player.qualityMax') },
          { value: '4320', label: '4320p (8K)' },
          { value: '2160', label: '2160p (4K)' },
          { value: '1440', label: '1440p (2K)' },
          { value: '1080', label: '1080p (Full HD)' },
          { value: '720', label: '720p (HD)' },
          { value: '480', label: '480p' },
          { value: '360', label: '360p' },
        ]),
        switchRow('rememberSpeed', t('pages.player.rememberSpeed'), t('pages.player.rememberSpeedDesc'))
      ),
      card(
        { title: t('pages.player.effectsTitle'), icon: 'bulb' },
        sliderRow('cinemaOpacity', t('pages.player.cinema'), t('pages.player.cinemaDesc'), { min: 0.5, max: 1, step: 0.05, format: (v) => P.formatPercent(v) }),
        sliderRow('boostMax', t('pages.player.boostMax'), t('pages.player.boostMaxDesc'), { min: 100, max: 600, step: 50, format: (v) => P.formatPercent(v / 100) })
      )
    );
  }

  /* ---------------------------------------------------------------- Clean up YouTube */
  function renderCleanup(body) {
    body.append(
      card(
        { title: t('pages.cleanup.title'), desc: t('pages.cleanup.cardDesc'), icon: 'eye-off' },
        switchRow('hideComments', t('pages.cleanup.hideComments'), t('pages.cleanup.hideCommentsDesc')),
        switchRow('hideRelated', t('pages.cleanup.hideRelated'), t('pages.cleanup.hideRelatedDesc')),
        switchRow('hideShorts', t('pages.cleanup.hideShorts'), t('pages.cleanup.hideShortsDesc')),
        switchRow('hideEndscreen', t('pages.cleanup.hideEndscreen'), t('pages.cleanup.hideEndscreenDesc')),
        switchRow('hideLiveChat', t('pages.cleanup.hideLiveChat'), t('pages.cleanup.hideLiveChatDesc'))
      )
    );
  }

  /* ---------------------------------------------------------------- Keyboard shortcuts */
  async function loadCommands() {
    try {
      const list = await P.withTimeout(chrome.commands.getAll(), 4000);
      state.commands = Array.isArray(list) ? list : [];
      state.commandsError = null;
    } catch (e) {
      state.commandsError = P.errorText(e);
    }
    if (shortcutPainter) shortcutPainter();
  }

  function keysEl(shortcut) {
    const keys = P.shortcutKeys(shortcut);
    if (!keys.length) return h('span', { class: 'op-kbd-none' }, t('pages.shortcuts.notSet'));
    const parts = [];
    keys.forEach((k, i) => {
      if (i) parts.push(h('span', { class: 'op-kbd-plus', 'aria-hidden': 'true' }, '+'));
      parts.push(h('kbd', { class: 'op-kbd' }, k));
    });
    return h('span', { class: 'op-kbds' }, parts);
  }

  function renderShortcuts(body) {
    const list = h('div', { class: 'op-shortcuts' });
    const paint = () => {
      clear(list);
      if (state.commandsError) {
        list.appendChild(h('div', { class: 'op-pad' }, ui.notice({ kind: 'error', text: state.commandsError })));
        return;
      }
      if (!state.commands) {
        list.appendChild(h('div', { class: 'op-loading' }, ui.spinner()));
        return;
      }
      const order = COMMANDS.map((c) => c[0]);
      const rank = (n) => (order.indexOf(n) === -1 ? 999 : order.indexOf(n));
      const cmds = state.commands.slice().sort((a, b) => rank(a.name) - rank(b.name));
      if (!cmds.length) list.appendChild(h('div', { class: 'op-pad op-muted' }, t('pages.shortcuts.none')));
      for (const c of cmds) {
        const def = COMMANDS.find((x) => x[0] === c.name);
        const label = def ? def[2]() : c.description || c.name;
        const r = row({ icon: def ? def[1] : 'keyboard', label, control: keysEl(c.shortcut), kind: 'shortcut', className: 'op-row--compact' });
        r.dataset.command = c.name;
        list.appendChild(r);
      }
    };
    shortcutPainter = paint;
    paint();
    const change = ui.button({ label: t('pages.shortcuts.change'), icon: 'external', variant: 'primary', size: 'sm', onClick: () => P.openShortcuts().catch((e) => ui.toast(P.errorText(e), { kind: 'error' })) });
    change.dataset.action = 'open-shortcuts';
    body.append(card({ title: t('pages.shortcuts.title'), desc: t('pages.shortcuts.cardDesc'), icon: 'keyboard', actions: change }, list), h('div', { class: 'op-tip' }, ui.notice({ kind: 'info', text: t('pages.shortcuts.note') })));
    loadCommands();
  }

  /* ---------------------------------------------------------------- Backup */
  function exportSettings() {
    try {
      const data = P.makeBackup(AYT.settings.export());
      const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: P.backupFilename(new Date()), class: 'ayt-hidden' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      ui.toast(t('pages.backup.exported'), { kind: 'success' });
    } catch (e) {
      ui.toast(t('error.generic', { message: P.errorText(e) }), { kind: 'error' });
    }
  }

  async function importFile(file) {
    try {
      if (file.size > P.BACKUP_MAX_BYTES) {
        ui.toast(t('pages.backup.tooBig'), { kind: 'error' });
        return;
      }
      const text = await P.withTimeout(file.text(), 10000);
      const res = P.parseBackup(text);
      if (!res.ok) {
        ui.toast(t('pages.backup.invalid'), { kind: 'error' });
        return;
      }
      // A shared "preset" file must not silently turn on the YouTube login or send downloads to a network folder.
      const risks = P.importRisks(AYT.settings.all(), res.settings);
      let declined = false;
      if (risks.length) {
        const accept = await confirmDialog({
          title: t('pages.backup.sensitiveTitle'),
          text: t('pages.backup.sensitiveText'),
          items: risks.map((x) => (x.name === 'useCookies' ? t('pages.backup.sensitiveCookies') : t('pages.backup.sensitiveFolder', { path: x.value }))),
          confirmLabel: t('pages.backup.sensitiveImport'),
          cancelLabel: t('pages.backup.sensitiveSkip'),
          warn: true,
        });
        if (!accept) {
          declined = true;
          for (const x of risks) delete res.settings[x.name];
        }
      }
      const count = Object.keys(res.settings).length;
      if (!count) {
        ui.toast(t('pages.backup.nothingImported'), { kind: 'info' });
        return;
      }
      await AYT.settings.import(res.settings);
      saved.show();
      let msg;
      if (declined) msg = t('pages.backup.sensitiveSkipped');
      else if (res.skipped.length) msg = t('pages.backup.importedSkipped', { count, skipped: res.skipped.length });
      else msg = t('pages.backup.imported', { count });
      ui.toast(msg, { kind: 'success' });
    } catch (e) {
      ui.toast(t('pages.backup.importFailed', { message: P.errorText(e) }), { kind: 'error' });
    }
  }

  /**
   * Modal confirmation built on <dialog>. Resolves true when confirmed (false: cancel button, Escape, backdrop).
   * o: { title, text, items?: string[] (bullet list), confirmLabel, cancelLabel?, icon?, danger?, warn? }
   */
  function confirmDialog(o) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try {
          dlg.close();
        } catch (_) {
          /* ignore */
        }
        dlg.remove();
        resolve(ok);
      };
      const cancel = ui.button({ label: o.cancelLabel || t('common.cancel'), onClick: () => finish(false) });
      cancel.dataset.action = 'cancel';
      const ok = ui.button({ label: o.confirmLabel, icon: o.icon || null, variant: o.danger ? 'danger' : 'primary', onClick: () => finish(true) });
      ok.dataset.action = 'confirm';
      const items = Array.isArray(o.items) && o.items.length ? h('ul', { class: 'op-dialog__list' }, o.items.map((x) => h('li', null, x))) : null;
      const dlg = h(
        'dialog',
        { class: ['op-dialog', o.warn && 'op-dialog--warn'], 'aria-labelledby': 'op-dlg-title', 'aria-describedby': 'op-dlg-text' },
        h('div', { class: 'op-dialog__icon', 'aria-hidden': 'true' }, icon(o.danger || o.warn ? 'warning' : 'info', { size: 22 })),
        h('h2', { class: 'op-dialog__title', id: 'op-dlg-title' }, o.title),
        h('div', { id: 'op-dlg-text' }, h('p', { class: 'op-dialog__text' }, o.text), items),
        h('div', { class: 'op-dialog__actions' }, cancel, ok)
      );
      dlg.addEventListener('cancel', (e) => {
        e.preventDefault();
        finish(false);
      });
      dlg.addEventListener('click', (e) => {
        if (e.target !== dlg) return;
        // A click on the dialog element itself is either its padding or the backdrop.
        const r = dlg.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) finish(false);
      });
      document.body.appendChild(dlg);
      try {
        dlg.showModal();
        cancel.focus();
      } catch (_) {
        dlg.setAttribute('open', '');
      }
    });
  }

  async function resetAll() {
    const ok = await confirmDialog({ title: t('pages.backup.resetConfirmTitle'), text: t('pages.backup.resetConfirmText'), confirmLabel: t('pages.backup.reset'), icon: 'trash', danger: true });
    if (!ok) return;
    try {
      await AYT.settings.reset();
      saved.show();
      ui.toast(t('pages.backup.resetDone'), { kind: 'success' });
    } catch (e) {
      ui.toast(t('pages.err.saveFailed', { message: P.errorText(e) }), { kind: 'error' });
    }
  }

  function renderBackup(body) {
    const fileInput = h('input', {
      type: 'file',
      accept: '.json,application/json',
      class: 'ayt-hidden',
      tabindex: '-1',
      'aria-hidden': 'true',
      on: {
        change: () => {
          const f = fileInput.files && fileInput.files[0];
          fileInput.value = '';
          if (f) importFile(f);
        },
      },
    });
    fileInput.dataset.action = 'import-file';
    const exportBtn = ui.button({ label: t('pages.backup.export'), icon: 'download', variant: 'primary', size: 'sm', onClick: exportSettings });
    exportBtn.dataset.action = 'export';
    const importBtn = ui.button({ label: t('pages.backup.import'), icon: 'file', size: 'sm', onClick: () => fileInput.click() });
    importBtn.dataset.action = 'import';
    const resetBtn = ui.button({ label: t('pages.backup.reset'), icon: 'trash', variant: 'danger', size: 'sm', onClick: resetAll });
    resetBtn.dataset.action = 'reset';
    body.append(
      card({ title: t('pages.backup.exportTitle'), desc: t('pages.backup.exportDesc'), icon: 'download', actions: exportBtn }),
      card({ title: t('pages.backup.importTitle'), desc: t('pages.backup.importDesc'), icon: 'file', actions: [importBtn, fileInput] }),
      card({ title: t('pages.backup.resetTitle'), desc: t('pages.backup.resetDesc'), icon: 'refresh', actions: resetBtn, className: 'op-card--danger' })
    );
  }

  /* ---------------------------------------------------------------- About */
  function renderAbout(body) {
    const version = P.extVersion();
    const credit = (name, desc, url, license) =>
      row({
        label: name,
        desc,
        extra: h('div', { class: 'op-license' }, ui.badge(license)),
        control: h('a', { class: 'ayt-btn ayt-btn--sm ayt-btn--ghost op-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, h('span', null, t('pages.about.website')), icon('external', { size: 16 })),
        kind: 'credit',
      });
    body.append(
      h(
        'div',
        { class: 'op-hero' },
        h('img', { class: 'op-hero__logo', src: '../icons/icon.svg', alt: '', width: 72, height: 72, draggable: false }),
        h('div', { class: 'op-hero__text' }, h('div', { class: 'op-hero__name' }, "Akif's Special YouTube Addon"), h('div', { class: 'op-hero__ver' }, t('pages.versionLabel', { version })), h('p', { class: 'op-hero__tagline' }, t('pages.about.tagline')))
      ),
      card(
        { title: t('pages.about.creditsTitle'), desc: t('pages.about.creditsDesc'), icon: 'sparkle' },
        credit('yt-dlp', t('pages.about.ytdlp'), 'https://github.com/yt-dlp/yt-dlp', 'Unlicense'),
        credit('FFmpeg', t('pages.about.ffmpeg'), 'https://ffmpeg.org/', 'LGPL / GPL'),
        credit('Deno', t('pages.about.deno'), 'https://deno.com/', 'MIT')
      ),
      card({ title: t('pages.about.legalTitle'), icon: 'flag' }, h('div', { class: 'op-prose' }, h('p', null, t('pages.about.personalUse')), h('p', null, t('pages.about.notAffiliated')))),
      card(
        { title: t('pages.about.privacyTitle'), icon: 'eye-off' },
        h(
          'div',
          { class: 'op-prose' },
          h('p', null, t('pages.about.privacy')),
          h('ul', { class: 'op-tips' }, h('li', null, t('pages.about.privacyLocal')), h('li', null, t('pages.about.privacyNoTracking')), h('li', null, t('pages.about.privacyCookies')))
        )
      )
    );
  }

  /* ---------------------------------------------------------------- Advanced (settings without a dedicated control) */
  function genericRow(name) {
    const def = AYT.DEFAULT_SETTINGS[name];
    const label = h('code', { class: 'op-code' }, name);
    if (typeof def === 'boolean') return switchRow(name, label, null);
    if (typeof def === 'number' || typeof def === 'string') {
      const isNum = typeof def === 'number';
      const input = h('input', { type: isNum ? 'number' : 'text', class: 'ayt-input op-generic', value: String(S(name)), spellcheck: false, dataset: { setting: name } });
      input.addEventListener('change', async () => {
        const v = await save(name, isNum ? Number(input.value) : input.value, () => (input.value = String(S(name))));
        if (v !== undefined) input.value = String(v);
      });
      bind(name, (v) => {
        if (document.activeElement !== input) input.value = String(v);
      });
      return row({ label, desc: t('pages.advanced.defaultValue', { value: String(def) }), control: input, kind: 'generic', setting: name, labelTarget: input });
    }
    // arrays / objects: read-only JSON view + reset
    const view = h('code', { class: 'op-code op-code--block' });
    const paint = () => (view.textContent = JSON.stringify(S(name)));
    paint();
    bind(name, paint);
    const reset = ui.button({ label: t('common.reset'), size: 'sm', onClick: () => save(name, Array.isArray(def) ? def.slice() : def) });
    return row({ label, extra: view, control: reset, kind: 'generic', setting: name });
  }

  function renderAdvanced(body) {
    const keys = extraSettings();
    if (!keys.length) {
      body.appendChild(ui.notice({ kind: 'info', text: t('pages.advanced.none') }));
      return;
    }
    body.appendChild(card({ title: t('pages.advanced.title'), desc: t('pages.advanced.cardDesc'), icon: 'sliders' }, keys.map(genericRow)));
  }

  /* ================================================================== boot */

  function onVisible() {
    if (document.hidden) return;
    if (state.section === 'shortcuts') loadCommands();
    // Back from running install.bat or the shortcuts page: refresh what may have changed.
    if (Date.now() - state.hostFetchedAt > 5000 && !state.hostLoading) loadHost(!!state.host && !isConnected());
  }

  async function boot() {
    await AYT.settings.load();
    AYT.i18n.setLanguage(S('language'));
    ui.applyTheme(document.documentElement);
    state.section = sectionFromHash();
    saved.mount();
    AYT.settings.onChange(onSettings);
    // Keyboard users change the language with the arrow keys (one re-render per step): keep their focus.
    AYT.i18n.onChange(() => P.keepFocus(app, render));
    AYT.client.on('host', (st) => {
      state.host = P.normalizeStatus(st);
      repaintHost();
    });
    render();
    app.removeAttribute('aria-busy');
    P.cachedHostStatus().then((st) => {
      if (st && !state.host) {
        state.host = st;
        repaintHost();
      }
    });
    if (!state.hostLoading) loadHost(false);
    window.addEventListener('hashchange', onHashChange);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    let resizeFrame = 0;
    window.addEventListener('resize', () => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        updateNavFade();
        runLayoutPainters();
      });
    });
  }

  boot().catch((e) => {
    console.error('[AYT] options failed to start', e);
    app.removeAttribute('aria-busy');
    clear(app);
    app.appendChild(h('div', { class: 'op-fatal' }, ui.notice({ kind: 'error', title: t('common.error'), text: P.errorText(e) })));
  });
})(globalThis);
