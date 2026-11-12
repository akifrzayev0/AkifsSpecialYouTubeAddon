/*
 * Akif's Special YouTube Addon — context menus (owner: BACKGROUND, spec §7.5).
 *
 * "Download video (best quality)" / "Download audio (MP3)" on YouTube video links (any site) and on YouTube
 * watch/Shorts pages. Clicks start companion jobs with the default settings (video: height null = best quality).
 *
 * Chrome keeps the items across service-worker restarts, browser restarts and updates, so they are built only
 * when needed:
 *   AYT.menus.onInstalled()   install / update: removeAll + create, in the UI language
 *   AYT.menus.ensure()        every service-worker start: nothing while chrome.storage.local['state.contextMenus']
 *                             says the items were titled in the current language; otherwise they are re-titled,
 *                             and created when one is missing
 *   AYT.menus.updateTitles()  UI language changed: update the titles (create the items when one is missing)
 * The operations run one after another (an install and the start-up check overlap).
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  const U = AYT.util;
  const t = (key, params) => AYT.t(key, params);

  const LINK_PATTERNS = ['*://*.youtube.com/watch*', '*://youtu.be/*', '*://*.youtube.com/shorts/*'];
  const PAGE_PATTERNS = ['*://*.youtube.com/watch*', '*://*.youtube.com/shorts/*'];

  /** Menu items. Page items only show when the click is not on a link (Chrome's 'page' context rule). */
  const ITEMS = [
    { id: 'ayt-link-video', kind: 'video', source: 'link', contexts: ['link'], targetUrlPatterns: LINK_PATTERNS },
    { id: 'ayt-link-audio', kind: 'audio', source: 'link', contexts: ['link'], targetUrlPatterns: LINK_PATTERNS },
    { id: 'ayt-page-video', kind: 'video', source: 'page', contexts: ['page', 'video'], documentUrlPatterns: PAGE_PATTERNS },
    { id: 'ayt-page-audio', kind: 'audio', source: 'page', contexts: ['page', 'video'], documentUrlPatterns: PAGE_PATTERNS },
  ];

  /** chrome.storage.local key: { lang } = the UI language the existing items are titled in. */
  const MARK_KEY = 'state.contextMenus';

  function titleFor(item) {
    return item.kind === 'video' ? t('background.menu.video') : t('background.menu.audio');
  }

  function propsFor(item) {
    const props = { id: item.id, title: titleFor(item), contexts: item.contexts };
    if (item.targetUrlPatterns) props.targetUrlPatterns = item.targetUrlPatterns;
    if (item.documentUrlPatterns) props.documentUrlPatterns = item.documentUrlPatterns;
    return props;
  }

  /**
   * Calls a chrome.contextMenus function with a callback (they take callbacks in every Chrome version this
   * extension supports). Resolves with chrome.runtime.lastError's message, '' on success. Never rejects.
   */
  function call(fn, ...args) {
    return new Promise((resolve) => {
      try {
        fn(...args, () => {
          const le = chrome.runtime.lastError;
          resolve(le ? le.message || String(le) : '');
        });
      } catch (e) {
        resolve(String((e && e.message) || e) || 'error');
      }
    });
  }

  async function readMark() {
    try {
      const v = (await chrome.storage.local.get(MARK_KEY))[MARK_KEY];
      return v && typeof v === 'object' && typeof v.lang === 'string' ? v : null;
    } catch (_) {
      return null;
    }
  }

  async function writeMark(lang) {
    try {
      await chrome.storage.local.set({ [MARK_KEY]: { lang } });
    } catch (e) {
      console.warn('[AYT] context menu state not saved', e);
    }
  }

  /** removeAll + create, titles in the current UI language. */
  async function build() {
    const lang = AYT.i18n.language;
    await call((done) => chrome.contextMenus.removeAll(done));
    const errors = (await Promise.all(ITEMS.map((item) => call((p, done) => chrome.contextMenus.create(p, done), propsFor(item))))).filter(Boolean);
    if (errors.length) console.warn('[AYT] context menu', errors.join('; '));
    else await writeMark(lang);
    return 'created';
  }

  /** Updates the titles; builds the items when one of them is missing ("Cannot find menu item"). */
  async function retitle() {
    const lang = AYT.i18n.language;
    const errors = await Promise.all(ITEMS.map((item) => call((id, p, done) => chrome.contextMenus.update(id, p, done), item.id, { title: titleFor(item) })));
    if (errors.some(Boolean)) return build();
    await writeMark(lang);
    return 'updated';
  }

  let queue = Promise.resolve();
  /** Runs fn after the menu operations already queued (it must not queue another one itself). */
  function serial(fn) {
    const run = queue.then(fn);
    queue = run.catch((e) => console.warn('[AYT] context menus', e));
    return run;
  }

  let installing = false; // an onInstalled build is on its way: the start-up check leaves the items to it

  /** onInstalled (install / update): build the items from scratch once start-up has loaded the language. */
  function onInstalled() {
    installing = true;
    return AYT.bgReady
      .then(() => serial(build))
      .finally(() => {
        installing = false;
      });
  }

  /**
   * Service-worker start: the items survive restarts, so they are touched only when they were never recorded as
   * built (first start, storage cleared) or are titled in another language. Resolves 'kept' | 'updated' |
   * 'created' | 'install' (an install/update builds them anyway).
   */
  function ensure() {
    return serial(async () => {
      if (installing) return 'install';
      const mark = await readMark();
      if (mark && mark.lang === AYT.i18n.language) return 'kept';
      return retitle();
    });
  }

  /** Re-translates the menu titles (UI language changed). */
  function updateTitles() {
    return serial(retitle);
  }

  /** (Re)creates the menu items with titles in the current UI language. */
  function setup() {
    return serial(build);
  }

  /** "Rick Astley - Never Gonna Give You Up - YouTube" -> "Rick Astley - Never Gonna Give You Up". */
  function cleanTabTitle(title) {
    return String(title || '')
      .replace(/^\(\d+\+?\)\s*/, '')
      .replace(/\s*[-–—]\s*YouTube\s*$/i, '')
      .trim()
      .slice(0, 300);
  }

  function taskFor(kind, videoId) {
    const url = U.watchUrl(videoId);
    if (kind === 'video') return { kind: 'video', videoId, url, playlist: false, height: null, width: null, hdr: null, fps: null };
    return { kind: 'audio', videoId, url, playlist: false, audioFormat: 'mp3' };
  }

  function labelFor(kind) {
    const s = AYT.settings.all();
    if (kind === 'video') return t('background.label.bestVideo', { container: String(s.videoContainer || 'mp4').toUpperCase() });
    const bitrate = AYT.MP3_BITRATES.includes(Number(s.audioBitrate)) ? Number(s.audioBitrate) : AYT.RECOMMENDED_MP3_BITRATE;
    return t('background.label.mp3', { bitrate });
  }

  /**
   * Handles a menu click: starts the job; when the companion is not installed, also opens the install guide.
   * @param {chrome.contextMenus.OnClickData} info
   * @param {chrome.tabs.Tab} [tab]
   */
  async function onClicked(info, tab) {
    const item = ITEMS.find((i) => i.id === (info && info.menuItemId));
    if (!item) return null;
    await AYT.bgReady;
    const url = item.source === 'link' ? info.linkUrl : info.pageUrl || (tab && tab.url);
    const videoId = U.videoIdFromUrl(url || '');
    if (!videoId) {
      AYT.bg.notify('ayt-menu-error', { title: t('background.menu.failed'), message: t('background.menu.noVideo') });
      return null;
    }
    let title = '';
    if (item.source === 'page' && tab && typeof tab.title === 'string' && U.videoIdFromUrl(tab.url || '') === videoId) title = cleanTabTitle(tab.title);
    let job = null;
    try {
      job = AYT.jobs.start(taskFor(item.kind, videoId), {
        title,
        videoId,
        thumbnail: 'https://i.ytimg.com/vi/' + videoId + '/mqdefault.jpg',
        label: labelFor(item.kind),
      });
    } catch (e) {
      AYT.bg.notify('ayt-menu-error', { title: t('background.menu.failed'), message: (e && e.message) || String(e) });
      return null;
    }
    try {
      const st = await AYT.native.check(false);
      if (st.state === 'missing' || st.state === 'forbidden' || st.state === 'outdated') await AYT.bg.openOptions('companion');
    } catch (_) {
      /* the job itself reports the problem */
    }
    return job;
  }

  try {
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      onClicked(info, tab).catch((e) => console.error('[AYT] context menu click failed', e));
    });
  } catch (e) {
    console.warn('[AYT] contextMenus unavailable', e);
  }

  AYT.menus = {
    ITEMS,
    MARK_KEY,
    setup,
    ensure,
    onInstalled,
    updateTitles,
    onClicked,
    cleanTabTitle,
    titles: () => ITEMS.map((i) => ({ id: i.id, title: titleFor(i) })),
  };
})(globalThis);
