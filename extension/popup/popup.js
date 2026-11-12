/*
 * Akif's Special YouTube Addon — toolbar popup (380 px wide, max 600 px tall).
 *
 *  header   logo, name, companion status pill (-> options #companion)
 *  card     "This video" quick downloads for the active YouTube watch/Shorts tab
 *  list     live downloads (AYT.ui.jobList) with empty state and "Clear finished"
 *  switches hide comments / Shorts / related videos / end-screen cards
 *  footer   language, keyboard shortcuts, settings, version
 *
 * Everything is localized and re-rendered when the UI language changes. The service worker may be
 * missing or slow: every request has a timeout and failures show a friendly state instead.
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  const { h, icon, clear } = AYT.dom;
  const ui = AYT.ui;
  const P = AYT.pages;
  const U = AYT.util;
  const t = (k, p) => AYT.t(k, p);

  const app = document.getElementById('app');
  const BLOCKING_HOST_STATES = ['missing', 'forbidden', 'error', 'outdated'];
  const HOST_POLL_MS = 1500;
  const HOST_POLL_MAX = 15;

  /** Cleanup switches shown in the popup (setting name -> label). */
  const QUICK_SWITCHES = [
    ['hideComments', () => t('pages.cleanup.hideComments')],
    ['hideShorts', () => t('pages.cleanup.hideShorts')],
    ['hideRelated', () => t('pages.cleanup.hideRelated')],
    ['hideEndscreen', () => t('pages.cleanup.hideEndscreen')],
  ];

  const state = {
    video: null, // AYT.pages.videoFromTab(activeTab) or null
    host: null, // HostStatus, null until the first answer
    jobsLoaded: false,
    jobsError: null,
    busy: { video: false, audio: false, page: false },
    clearing: false,
  };
  const refs = { pill: null, card: null, jobsState: null, jobsCount: null, clearBtn: null, switches: new Map() };
  let jobList = null;
  let hostPollTimer = 0;
  let hostPolls = 0;
  let torndown = false;

  // In the small popup, toasts sit above the footer (not over the video card), centred across the full width
  // with 12 px margins; the shared default is the bottom-right corner of a page with 24 px margins.
  ui.addStyles('.ayt-toasts { top: auto; left: 0; right: 0; bottom: 60px; padding: 0 12px; transform: none; align-items: center; }');
  // Theme as early as possible (before settings are loaded it follows the system theme).
  ui.mountStyles(document);
  ui.applyTheme(document.documentElement);

  /* ------------------------------------------------------------------ boot */

  async function activeTab() {
    try {
      const tabs = await P.withTimeout(chrome.tabs.query({ active: true, currentWindow: true }), 2500);
      return (tabs && tabs[0]) || null;
    } catch (e) {
      console.warn('[AYT] popup: could not read the active tab', e);
      return null;
    }
  }

  async function boot() {
    const [, tab] = await Promise.all([AYT.settings.load(), activeTab()]);
    AYT.i18n.setLanguage(AYT.settings.get('language'));
    ui.applyTheme(document.documentElement); // explicit dark/light setting
    state.video = P.videoFromTab(tab);

    // Listeners registered before the job list so the "loaded" flag is set before it renders.
    AYT.client.on('jobs', onJobsSnapshot);
    AYT.client.on('host', onHost);
    AYT.settings.onChange(onSettings);
    // Arrowing through the language select re-renders on every step: the select keeps the keyboard focus.
    AYT.i18n.onChange(() => P.keepFocus(app, render));
    AYT.client.retain(); // live job/host updates while the popup is open

    render();
    app.removeAttribute('aria-busy');
    loadJobs();
    // Paint the last known companion status right away, then ask the service worker.
    let fetched = false;
    P.cachedHostStatus().then((st) => {
      if (st && !fetched && !state.host) onHost(st);
    });
    loadHost(false).then(() => {
      fetched = true;
      // The worker caches answers for a minute: re-check once when the companion looked unusable, so a
      // companion installed a moment ago shows up right away.
      const st = state.host;
      if (st && BLOCKING_HOST_STATES.includes(st.state) && Date.now() - (Number(st.checkedAt) || 0) > 10000) loadHost(true);
    });
    window.addEventListener('pagehide', teardown);
  }

  function teardown() {
    if (torndown) return;
    torndown = true;
    clearTimeout(hostPollTimer);
    if (jobList) jobList.destroy();
    jobList = null;
    AYT.client.release();
  }

  /* ------------------------------------------------------------------ data */

  function onJobsSnapshot() {
    state.jobsLoaded = true;
    state.jobsError = null;
  }

  async function loadJobs() {
    try {
      await P.withTimeout(AYT.client.syncJobs(), P.TIMEOUTS.jobs);
      state.jobsError = null;
    } catch (e) {
      // The live port may already have delivered a snapshot; only complain when nothing arrived.
      if (!state.jobsLoaded) state.jobsError = P.errorText(e);
    }
    state.jobsLoaded = true;
    updateJobsMeta();
  }

  function onHost(status) {
    state.host = P.normalizeStatus(status);
    paintPill();
    paintCard();
    scheduleHostPoll();
  }

  async function loadHost(force) {
    const st = await P.fetchHostStatus(force); // never throws
    if (torndown) return;
    onHost(st);
  }

  /** While the service worker reports 'checking', ask again (pushes may not arrive without the companion). */
  function scheduleHostPoll() {
    clearTimeout(hostPollTimer);
    if (!state.host || state.host.state !== 'checking') {
      hostPolls = 0;
      return;
    }
    if (hostPolls >= HOST_POLL_MAX) {
      hostPolls = 0;
      state.host = { state: 'unknown', error: t('pages.err.timeout') };
      paintPill();
      paintCard();
      return;
    }
    hostPollTimer = setTimeout(() => {
      hostPolls++;
      loadHost(false);
    }, HOST_POLL_MS);
  }

  function onSettings(changes) {
    if ('language' in changes) AYT.i18n.setLanguage(changes.language); // re-renders through i18n.onChange
    for (const [name] of QUICK_SWITCHES) {
      if (name in changes && refs.switches.has(name)) refs.switches.get(name).checked = !!changes[name];
    }
    if ('audioFormat' in changes || 'audioBitrate' in changes || 'videoContainer' in changes) paintCard();
  }

  /* ------------------------------------------------------------------ render */

  function render() {
    if (jobList) jobList.destroy();
    jobList = null;
    refs.switches = new Map();
    clear(app);
    app.append(renderHeader(), renderMain(), renderFooter());
    paintPill();
    paintCard();
    updateJobsMeta();
  }

  function renderHeader() {
    refs.pill = h('button', { type: 'button', class: 'pp-pill', on: { click: () => go(() => P.openOptions('companion')) } });
    return h(
      'header',
      { class: 'pp-header' },
      h('img', { class: 'pp-logo', src: '../icons/icon.svg', alt: '', width: 30, height: 30, draggable: false }),
      h('div', { class: 'pp-brand' }, h('div', { class: 'pp-brand__name' }, "Akif's Special YouTube Addon")),
      refs.pill
    );
  }

  function paintPill() {
    const pill = refs.pill;
    if (!pill) return;
    const st = state.host || { state: 'checking' };
    const view = P.hostView(st);
    pill.className = 'pp-pill pp-pill--' + view.tone;
    clear(pill);
    pill.append(h('span', { class: 'pp-pill__dot', 'aria-hidden': 'true' }), h('span', { class: 'pp-pill__text' }, view.pill));
    // forbidden / error: the reason the service worker found (status.error); the pill is the only status off YouTube
    let tip = P.hostLine(st);
    const ytdlp = st.tools && st.tools.ytdlp && st.tools.ytdlp.version;
    if (view.state === 'connected' && ytdlp) tip = t('pages.host.tipConnected', { ytdlp: String(ytdlp) });
    pill.title = tip;
    pill.setAttribute('aria-label', t('pages.popup.companionStatus', { status: view.pill }));
  }

  function renderMain() {
    refs.card = h('div', { class: 'pp-card-slot' });
    return h('main', { class: 'pp-main' }, refs.card, renderDownloads(), renderSwitches());
  }

  /* ---------------- "This video" card */

  function thumbUrl(videoId) {
    return 'https://i.ytimg.com/vi/' + encodeURIComponent(videoId) + '/mqdefault.jpg';
  }

  function audioLabel(s) {
    const fmt = s.audioFormat || 'mp3';
    return fmt === 'mp3' ? t('pages.popup.labelMp3', { bitrate: s.audioBitrate }) : P.audioFormatLabel(fmt);
  }

  function busyButton(btn, busy) {
    if (!busy) return btn;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    const first = btn.firstChild;
    if (first) btn.replaceChild(ui.spinner(), first);
    return btn;
  }

  function paintCard() {
    const slot = refs.card;
    if (!slot) return;
    clear(slot);
    const v = state.video;
    if (!v) {
      slot.appendChild(
        h(
          'section',
          { class: 'pp-hint', 'aria-label': t('pages.popup.thisVideo') },
          h('div', { class: 'pp-hint__icon' }, icon('play', { size: 18 })),
          h('div', { class: 'pp-hint__body' }, h('div', { class: 'pp-hint__title' }, t('pages.popup.noVideoTitle')), h('div', { class: 'pp-hint__text' }, t('pages.popup.noVideoText'))),
          ui.button({ label: t('pages.popup.openYouTube'), size: 'sm', onClick: () => go(() => chrome.tabs.create({ url: 'https://www.youtube.com/' })) })
        )
      );
      return;
    }
    const s = AYT.settings.all();
    const blocked = !!(state.host && BLOCKING_HOST_STATES.includes(state.host.state));
    const anyBusy = state.busy.video || state.busy.audio;
    const videoBtn = busyButton(
      ui.button({ label: t('pages.popup.bestVideo'), icon: 'video', variant: 'primary', block: true, disabled: blocked || anyBusy, onClick: startVideo }),
      state.busy.video
    );
    videoBtn.dataset.action = 'video';
    const audioBtn = busyButton(ui.button({ label: audioLabel(s), icon: 'music', block: true, disabled: blocked || anyBusy, onClick: startAudio }), state.busy.audio);
    audioBtn.dataset.action = 'audio';

    const title = v.title || t('pages.popup.untitled');
    const metaBits = [];
    if (v.surface === 'shorts') metaBits.push(ui.badge('Shorts', 'soft'));
    metaBits.push(h('span', { class: 'pp-video__id' }, v.videoId));

    const img = h('img', {
      src: thumbUrl(v.videoId),
      alt: '',
      draggable: false,
      on: { error: () => img.classList.add('is-broken') },
    });

    slot.appendChild(
      h(
        'section',
        { class: 'pp-video', 'aria-labelledby': 'pp-video-label' },
        h(
          'div',
          { class: 'pp-video__top' },
          h('div', { class: ['pp-video__thumb', v.surface === 'shorts' && 'is-shorts'] }, img),
          h(
            'div',
            { class: 'pp-video__info' },
            h('div', { class: 'pp-video__label', id: 'pp-video-label' }, t('pages.popup.thisVideo')),
            h('div', { class: 'pp-video__title', title }, title),
            h('div', { class: 'pp-video__meta' }, metaBits)
          )
        ),
        blocked ? companionNotice() : null,
        h('div', { class: 'pp-video__actions' }, videoBtn, audioBtn),
        v.hasToolbar && v.tabId != null
          ? h(
              'button',
              { type: 'button', class: 'pp-link', disabled: state.busy.page, on: { click: openPanelOnPage } },
              h('span', null, t('pages.popup.chooseQuality')),
              icon('chevron-right', { size: 16 })
            )
          : null
      )
    );
  }

  function companionNotice() {
    const st = state.host;
    const view = P.hostView(st);
    // Blocked by an administrator policy: there is nothing to set up; the options page explains it.
    const policy = st.state === 'forbidden' && st.reason === 'policy';
    return h(
      'div',
      { class: ['pp-need', 'pp-need--' + view.tone], role: 'status' },
      icon(view.icon === 'check-circle' ? 'info' : view.icon, { size: 16 }),
      h('span', { class: 'pp-need__text' }, st.state === 'missing' ? t('pages.popup.needsCompanion') : P.hostLine(st)),
      h('button', { type: 'button', class: 'pp-need__btn', on: { click: () => go(() => P.openOptions('companion')) } }, policy ? t('common.learnMore') : t('pages.popup.setUp'))
    );
  }

  async function startJob(which, task, meta) {
    if (state.busy.video || state.busy.audio) return;
    state.busy[which] = true;
    paintCard();
    try {
      await P.withTimeout(AYT.client.jobs.start(task, meta), P.TIMEOUTS.job);
      ui.toast(t('job.started'), { kind: 'success' });
    } catch (e) {
      ui.toast(P.errorText(e), { kind: 'error' });
    } finally {
      state.busy[which] = false;
      paintCard();
    }
  }

  function startVideo() {
    const v = state.video;
    if (!v) return;
    const s = AYT.settings.all();
    const container = s.videoContainer || 'mp4';
    const task = {
      kind: 'video',
      videoId: v.videoId,
      url: U.watchUrl(v.videoId),
      playlist: false,
      height: null, // best available
      width: null,
      hdr: null,
      fps: null,
      container,
      codec: s.videoCodec || 'auto',
      audioLang: null,
      section: null,
      preciseCut: false,
    };
    const meta = {
      title: v.title || v.videoId,
      videoId: v.videoId,
      thumbnail: thumbUrl(v.videoId),
      label: t('pages.popup.labelBest', { container: container.toUpperCase() }),
    };
    return startJob('video', task, meta);
  }

  function startAudio() {
    const v = state.video;
    if (!v) return;
    const s = AYT.settings.all();
    const task = {
      kind: 'audio',
      videoId: v.videoId,
      url: U.watchUrl(v.videoId),
      playlist: false,
      audioFormat: s.audioFormat || 'mp3',
      bitrate: s.audioBitrate,
      audioLang: null,
      section: null,
      embedThumbnail: !!s.embedThumbnail,
      embedMetadata: !!s.embedMetadata,
    };
    const meta = { title: v.title || v.videoId, videoId: v.videoId, thumbnail: thumbUrl(v.videoId), label: audioLabel(s) };
    return startJob('audio', task, meta);
  }

  /** Sends a push straight to the YouTube tab (same format the service worker uses for keyboard commands). */
  function sendToTab(tabId, msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.tabs.sendMessage(tabId, msg, () => {
          const err = chrome.runtime.lastError;
          // Nobody answers a push: "message port closed" means it was delivered.
          if (err && !/message port closed/i.test(err.message || '')) reject(new Error(err.message));
          else resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Opens the full download panel (all qualities) on the page itself, then closes the popup. A mouse click
   * (e.detail > 0) opens it like a mouse open, so focus stays on the panel and Space keeps controlling the video;
   * Enter/Space on the link (e.detail === 0) opens it like a keyboard open (focus on the best row).
   */
  async function openPanelOnPage(e) {
    const v = state.video;
    if (!v || v.tabId == null || state.busy.page) return;
    state.busy.page = true;
    const viaKeyboard = !(e && e.detail > 0);
    try {
      await P.withTimeout(sendToTab(v.tabId, { __aytPush: true, type: AYT.PUSH.COMMAND, command: 'open-download', viaKeyboard }), 3000);
      window.close();
    } catch (e) {
      ui.toast(t('pages.popup.pageNotReady'), { kind: 'warn' });
    } finally {
      state.busy.page = false;
    }
  }

  /* ---------------- downloads */

  function renderDownloads() {
    refs.jobsCount = h('span', { class: 'ayt-badge ayt-badge--soft ayt-hidden' });
    refs.clearBtn = ui.button({ label: t('pages.popup.clearFinished'), icon: 'trash', size: 'sm', variant: 'ghost', disabled: true, onClick: clearFinished });
    refs.clearBtn.dataset.action = 'clear';
    refs.jobsState = h('div', { class: 'pp-jobs-state' });
    jobList = ui.jobList({ max: 30, compact: true, onChange: () => updateJobsMeta() });
    jobList.el.classList.add('pp-jobs');
    return h(
      'section',
      { class: 'pp-section', 'aria-labelledby': 'pp-dl-title' },
      h('div', { class: 'pp-section__head' }, h('h2', { class: 'pp-section__title', id: 'pp-dl-title' }, t('common.downloads')), refs.jobsCount, h('span', { class: 'ayt-grow' }), refs.clearBtn),
      refs.jobsState,
      jobList.el
    );
  }

  function emptyState(iconName, title, text) {
    return h('div', { class: 'pp-empty' }, h('div', { class: 'pp-empty__icon' }, icon(iconName, { size: 22 })), h('div', { class: 'pp-empty__title' }, title), text ? h('div', { class: 'pp-empty__text' }, text) : null);
  }

  function updateJobsMeta() {
    const all = AYT.client.jobs.list();
    const active = all.filter((j) => AYT.client.jobs.isActive(j)).length;
    const finished = all.length - active;
    if (refs.jobsCount) {
      refs.jobsCount.textContent = active ? t('pages.popup.activeCount', { count: active }) : '';
      refs.jobsCount.classList.toggle('ayt-hidden', !active);
    }
    if (refs.clearBtn) refs.clearBtn.disabled = !finished || state.clearing;
    const box = refs.jobsState;
    if (!box) return;
    clear(box);
    box.classList.toggle('ayt-hidden', all.length > 0);
    if (all.length) return;
    if (!state.jobsLoaded) box.appendChild(h('div', { class: 'pp-empty pp-empty--loading' }, ui.spinner()));
    else if (state.jobsError) box.appendChild(emptyState('warning', t('pages.popup.jobsErrorTitle'), state.jobsError));
    else box.appendChild(emptyState('download', t('pages.popup.emptyTitle'), t('pages.popup.emptyText')));
  }

  async function clearFinished() {
    if (state.clearing) return;
    state.clearing = true;
    updateJobsMeta();
    try {
      await P.withTimeout(AYT.client.jobs.clear(), P.TIMEOUTS.quick);
      await P.withTimeout(AYT.client.syncJobs(), P.TIMEOUTS.jobs).catch(() => {});
    } catch (e) {
      ui.toast(P.errorText(e), { kind: 'error' });
    } finally {
      state.clearing = false;
      updateJobsMeta();
    }
  }

  /* ---------------- quick switches */

  function renderSwitches() {
    const box = h('div', { class: 'pp-switches' });
    for (const [name, label] of QUICK_SWITCHES) {
      const sw = ui.switchControl({ label: label(), checked: !!AYT.settings.get(name), onChange: (v) => saveSwitch(name, v, sw) });
      sw.input.setAttribute('role', 'switch');
      sw.el.dataset.setting = name;
      refs.switches.set(name, sw);
      box.appendChild(sw.el);
    }
    return h(
      'section',
      { class: 'pp-section', 'aria-labelledby': 'pp-sw-title' },
      h('div', { class: 'pp-section__head' }, h('h2', { class: 'pp-section__title', id: 'pp-sw-title' }, t('pages.popup.quickSwitches'))),
      box
    );
  }

  async function saveSwitch(name, value, sw) {
    try {
      await P.saveSetting(name, value);
    } catch (e) {
      sw.checked = !value;
      ui.toast(t('pages.err.saveFailed', { message: P.errorText(e) }), { kind: 'error' });
    }
  }

  /* ---------------- footer */

  function renderFooter() {
    const langOptions = P.languageOptions();
    const lang = ui.select({
      options: langOptions,
      value: AYT.settings.get('language'),
      ariaLabel: t('common.language'),
      onChange: (v) => {
        P.saveSetting('language', v).catch((e) => ui.toast(t('pages.err.saveFailed', { message: P.errorText(e) }), { kind: 'error' }));
      },
    });
    P.applyOptionLangs(lang.select, langOptions);
    lang.select.dataset.setting = 'language';
    const shortcuts = ui.button({ icon: 'keyboard', size: 'sm', variant: 'ghost', title: t('pages.popup.shortcuts'), onClick: () => go(P.openShortcuts) });
    shortcuts.dataset.action = 'shortcuts';
    const settings = ui.button({ icon: 'settings', label: t('common.settings'), size: 'sm', variant: 'ghost', onClick: () => go(() => P.openOptions()) });
    settings.dataset.action = 'settings';
    const version = P.extVersion();
    return h(
      'footer',
      { class: 'pp-footer' },
      h('div', { class: 'pp-lang', title: t('common.language') }, icon('globe', { size: 16, className: 'pp-lang__icon' }), lang.el),
      h('span', { class: 'ayt-grow' }),
      shortcuts,
      settings,
      h('span', { class: 'pp-version', title: t('pages.versionLabel', { version }) }, 'v' + version)
    );
  }

  /** Runs a navigation action and closes the popup; shows the error otherwise. */
  async function go(fn) {
    try {
      await fn();
      window.close();
    } catch (e) {
      ui.toast(P.errorText(e), { kind: 'error' });
    }
  }

  boot().catch((e) => {
    console.error('[AYT] popup failed to start', e);
    app.removeAttribute('aria-busy');
    clear(app);
    app.appendChild(h('div', { class: 'pp-fatal' }, ui.notice({ kind: 'error', title: t('common.error'), text: P.errorText(e) })));
  });
})(globalThis);
