/*
 * Akif's Special YouTube Addon — content-script entry point (loaded last).
 * Loads settings, sets the UI language, initializes features and the toolbar,
 * and routes keyboard-shortcut commands from the service worker.
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || AYT.booted || !AYT.isTopFrame) return;
  AYT.booted = true;

  function safe(label, fn) {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch((e) => console.error('[AYT]', label, e));
    } catch (e) {
      console.error('[AYT]', label, e);
    }
  }

  /** opts: { viaKeyboard: false } when the popup link was clicked with the mouse (see client.js PUSH.COMMAND). */
  function dispatchCommand(command, opts) {
    for (const def of AYT.toolbar.list()) {
      if (def.commands && typeof def.commands[command] === 'function') return safe('command ' + command, () => def.commands[command](opts));
    }
    for (const f of AYT.features.list()) {
      if (f.commands && typeof f.commands[command] === 'function') return safe('command ' + command, () => f.commands[command](opts));
    }
  }

  const hasActiveJob = (list) => Array.isArray(list) && list.some((j) => j && typeof j === 'object' && AYT.client.jobs.isActive(j));

  /**
   * Job snapshot for the toolbar's progress rings and download badge (an open panel gets its own snapshot).
   * JOBS_LIST wakes the service worker and copies the job list into the tab, so it is requested only when it can
   * matter:
   *  - a job list in chrome.storage.local (the service worker's fallback when IndexedDB fails, or a version that
   *    has not migrated yet) is read without waking anything: sync only when it has an active job;
   *  - otherwise the list lives in the service worker's IndexedDB, which this tab cannot read: whether a download
   *    is running is unknown, so sync once, the first time this tab shows a watch page while it is visible (the
   *    toolbar is only there). A download that was running when the tab (re)loaded shows its ring again.
   */
  async function syncJobsIfActive() {
    let list;
    try {
      const got = await chrome.storage.local.get(AYT.STORAGE.JOBS);
      list = got && got[AYT.STORAGE.JOBS];
    } catch (_) {
      /* storage unavailable: unknown */
    }
    if (Array.isArray(list)) {
      if (hasActiveJob(list)) await AYT.client.syncJobs();
      return;
    }
    onceVisibleWatch(() => AYT.client.syncJobs().catch(() => {}));
  }

  /** Runs fn once, the first time this tab shows a watch page while it is visible (right away when it does now). */
  function onceVisibleWatch(fn) {
    let stop = null;
    const check = () => {
      if (!stop || document.visibilityState === 'hidden' || !AYT.page.isWatch()) return;
      stop();
      stop = null;
      fn();
    };
    const offPage = AYT.page.onChange(check);
    document.addEventListener('visibilitychange', check);
    stop = () => {
      offPage();
      document.removeEventListener('visibilitychange', check);
    };
    check();
  }

  /**
   * A download started later (in another tab, the popup or a context menu) shows up in a job list persisted in
   * chrome.storage.local (the fallback storage only; throttled to 1/s by the service worker): sync once when this
   * tab does not know of any active job yet. Once it does, the live port of AYT.client keeps it up to date.
   */
  function watchJobStarts() {
    let last = 0;
    let busy = false;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        const ch = area === 'local' && changes[AYT.STORAGE.JOBS];
        if (!ch || busy || AYT.client.invalidated || AYT.client.jobs.active().length) return;
        if (!hasActiveJob(ch.newValue) || Date.now() - last < 3000) return;
        last = Date.now();
        busy = true;
        AYT.client
          .syncJobs()
          .catch(() => {})
          .finally(() => (busy = false));
      });
    } catch (_) {
      /* not available */
    }
  }

  async function boot() {
    await AYT.settings.load();
    AYT.i18n.setLanguage(AYT.settings.get('language'));
    AYT.settings.onChange((changes) => {
      if ('language' in changes) AYT.i18n.setLanguage(changes.language);
    });

    for (const f of AYT.features.list()) if (f.init) safe('init ' + f.id, () => f.init());

    AYT.page.onChange((info, prev, reason) => {
      for (const f of AYT.features.list()) if (f.onPageChange) safe('page ' + f.id, () => f.onPageChange(info, prev, reason));
    });
    AYT.settings.onChange((changes, all) => {
      for (const f of AYT.features.list()) if (f.onSettings) safe('settings ' + f.id, () => f.onSettings(changes, all));
    });
    AYT.client.on('command', dispatchCommand);

    AYT.toolbar.start();

    // Pick up downloads that are still running (progress rings on the toolbar).
    syncJobsIfActive().catch(() => {});
    watchJobStarts();
  }

  boot().catch((e) => console.error('[AYT] boot failed', e));
})(globalThis);
