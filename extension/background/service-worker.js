/*
 * Akif's Special YouTube Addon — service worker entry (owner: BACKGROUND, spec §7).
 *
 * Classic MV3 service worker. Every listener is registered synchronously at the top level (so events wake the
 * worker); async start-up (settings, language, stored jobs/host status, the context-menu check) is AYT.bgReady and
 * every handler waits for it.
 *
 *   chrome.runtime.onMessage   router for every AYT.MSG.* -> { ok:true, ... } | { ok:false, error, code }
 *   chrome.runtime.onConnect   'ayt-ui' ports: snapshot { type: PUSH.JOBS } + { type: PUSH.HOST } then live pushes
 *   chrome.runtime.onInstalled install/update -> context menus built; install -> options page #companion
 */
importScripts(
  '../shared/constants.js',
  '../shared/utils.js',
  '../shared/i18n.js',
  '../shared/i18n/en.js',
  '../shared/i18n/az.js',
  '../shared/i18n/tr.js',
  '../shared/i18n/ru.js',
  '../shared/i18n/fr.js',
  '../shared/i18n/de.js',
  '../shared/i18n/es.js',
  '../shared/settings.js',
  'hub.js',
  'task.js',
  'native.js',
  'jobs.js',
  'downloads.js',
  'menus.js',
  'commands.js'
);

(function (g) {
  'use strict';
  const AYT = g.AYT;
  const MSG = AYT.MSG;
  const t = (key, params) => AYT.t(key, params);
  const E = (code, message) => AYT.bg.error(code, message);

  /* ------------------------------------------------------------------ start-up */

  function onLanguageChanged() {
    AYT.menus.updateTitles().catch(() => {});
    AYT.jobs.relocalize();
    AYT.native.relocalize();
  }

  AYT.bgReady = (async () => {
    try {
      await AYT.settings.load();
    } catch (e) {
      console.warn('[AYT] settings load failed', e);
    }
    AYT.i18n.setLanguage(AYT.settings.get('language'));
    const lang = AYT.i18n.language;
    // The context menus persist across restarts: ensure() only re-titles them after a language change (or builds
    // them when they were never built); onInstalled builds them on install/update.
    const results = await Promise.allSettled([AYT.native.init(), AYT.jobs.init(), AYT.menus.ensure()]);
    for (const r of results) if (r.status === 'rejected') console.error('[AYT] start-up step failed', r.reason);
    // Listen only now: a change during start-up must not broadcast a half-loaded job list.
    AYT.i18n.onChange(onLanguageChanged);
    if (AYT.i18n.language !== lang) onLanguageChanged();
  })().catch((e) => console.error('[AYT] start-up failed', e));

  AYT.settings.onChange((changes) => {
    if ('language' in changes) AYT.i18n.setLanguage(changes.language);
    if ('maxConcurrent' in changes) AYT.jobs.pump();
  });

  /* ------------------------------------------------------------------ message router */

  const MSG_PREFIX_RE = /^(host|job|jobs|download|fetch|thumb|options|tab):/;

  function jobIdOf(msg) {
    if (!AYT.jobs.isValidId(msg.jobId)) throw E('bad_request', t('background.err.badRequest'));
    return msg.jobId;
  }

  function sectionOf(v) {
    if (v === undefined || v === null || v === '') return '';
    if (typeof v !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(v)) throw E('bad_request', t('background.err.badRequest'));
    return v;
  }

  /** Senders allowed to drive the companion directly (folder picker, tool updates): our pages + YouTube tabs. */
  function requireTrusted(sender) {
    if (!AYT.bg.isExtensionSender(sender) && !AYT.bg.isYouTubeSender(sender)) throw E('forbidden', t('background.err.badRequest'));
  }

  /** { tabId } of the sending tab (content scripts, an options tab); none for the popup. */
  function originOf(sender) {
    const tab = sender && sender.tab;
    return tab && typeof tab.id === 'number' && tab.id >= 0 ? { tabId: tab.id } : {};
  }

  const HANDLERS = {
    [MSG.HOST_STATUS]: async (msg) => ({ status: await AYT.native.check(msg.refresh === true) }),
    [MSG.HOST_OPEN]: async (msg) => {
      if (msg.target !== undefined && msg.target !== 'file' && msg.target !== 'folder') throw E('bad_request', t('background.err.badRequest'));
      await AYT.jobs.open(jobIdOf(msg), msg.target || 'file');
      return {};
    },
    [MSG.HOST_PICK_FOLDER]: async (msg, sender) => {
      requireTrusted(sender);
      return AYT.native.pickFolder();
    },
    [MSG.HOST_UPDATE_TOOLS]: async (msg, sender) => {
      requireTrusted(sender);
      return AYT.native.updateTools();
    },
    // Jobs leave the service worker as AYT.jobs.view(job): the UI shape without files[], meta and errorDetail.
    // A tab may have at most AYT.jobs.config.maxActivePerTab jobs queued or running (code too_many_jobs).
    [MSG.JOB_START]: async (msg, sender) => {
      const job = AYT.jobs.start(msg.task, msg.meta, originOf(sender));
      return { jobId: job.id, job: AYT.jobs.view(job) };
    },
    [MSG.JOB_CANCEL]: async (msg) => {
      AYT.jobs.cancel(jobIdOf(msg));
      return {};
    },
    [MSG.JOB_RETRY]: async (msg, sender) => {
      const job = AYT.jobs.retry(jobIdOf(msg), originOf(sender));
      return { jobId: job.id, job: AYT.jobs.view(job) };
    },
    [MSG.JOB_REMOVE]: async (msg) => {
      AYT.jobs.remove(jobIdOf(msg));
      return {};
    },
    [MSG.JOBS_LIST]: async () => ({ jobs: AYT.jobs.views() }),
    [MSG.JOBS_CLEAR]: async () => ({ removed: AYT.jobs.clear() }),
    [MSG.DOWNLOAD_DATA]: (msg) => AYT.downloads.downloadData(msg),
    [MSG.DOWNLOAD_URL]: (msg, sender) => AYT.downloads.downloadUrl(msg, sender),
    [MSG.FETCH_IMAGE]: (msg, sender) => AYT.downloads.fetchImage(msg, sender),
    [MSG.THUMB_PROBE]: (msg) => AYT.downloads.thumbProbe(msg),
    [MSG.OPEN_OPTIONS]: async (msg) => {
      await AYT.bg.openOptions(sectionOf(msg.section));
      return {};
    },
    [MSG.OPEN_TAB]: async (msg) => {
      await AYT.bg.openTab(msg.url);
      return {};
    },
  };

  /**
   * Routes one message. Exposed as AYT.bgRoute for tests.
   * @returns {Promise<object>} the response object
   */
  async function route(msg, sender) {
    await AYT.bgReady;
    const handler = msg && typeof msg.type === 'string' && Object.prototype.hasOwnProperty.call(HANDLERS, msg.type) ? HANDLERS[msg.type] : null;
    if (!handler) throw E('bad_request', t('background.err.badRequest'));
    const res = await handler(msg, sender || {});
    return Object.assign({ ok: true }, res || {});
  }
  AYT.bgRoute = route;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.__aytPush === true) return false;
    if (msg.__aytWake) {
      sendResponse({ ok: true });
      return false;
    }
    if (typeof msg.type !== 'string' || !Object.prototype.hasOwnProperty.call(HANDLERS, msg.type)) {
      // Answer only messages that look like ours; leave anything else to other extension pages.
      if (typeof msg.type === 'string' && MSG_PREFIX_RE.test(msg.type)) {
        sendResponse({ ok: false, error: t('background.err.badRequest'), code: 'bad_request' });
      }
      return false;
    }
    route(msg, sender)
      .then(sendResponse, (e) => {
        const res = AYT.bg.errorResponse(e);
        if (res.code === 'internal') console.error('[AYT] handler failed', msg.type, e);
        sendResponse(res);
      })
      .catch(() => {});
    return true;
  });

  /* ------------------------------------------------------------------ UI ports */

  chrome.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== AYT.PORT_UI) return;
    if (!port.sender || port.sender.id !== chrome.runtime.id) {
      try {
        port.disconnect();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    AYT.bg.addPort(port);
    port.onMessage.addListener(() => {
      /* UI ports only receive pushes; incoming traffic merely keeps the worker alive */
    });
    AYT.bgReady
      .then(() => {
        if (!AYT.bg.ports.has(port)) return;
        AYT.bg.post(port, { type: AYT.PUSH.JOBS, jobs: AYT.jobs.views() });
        const status = AYT.native.status;
        if (status && status.state !== 'unknown' && status.state !== 'checking') AYT.bg.post(port, { type: AYT.PUSH.HOST, status });
      })
      .catch((e) => console.error('[AYT] port snapshot failed', e));
  });

  /* ------------------------------------------------------------------ install */

  chrome.runtime.onInstalled.addListener((details) => {
    const reason = details && details.reason;
    // Chrome keeps context-menu items across restarts and updates: they are (re)built here, not on every start.
    if (reason === 'install' || reason === 'update') {
      AYT.menus.onInstalled().catch((e) => console.warn('[AYT] context menus not created', e));
    }
    if (reason === 'install') {
      AYT.bg.openOptions('companion').catch((e) => console.warn('[AYT] could not open the options page', e));
    }
  });
})(globalThis);
