/*
 * Akif's Special YouTube Addon — companion download jobs (owner: BACKGROUND, spec §7.3).
 *
 *   AYT.jobs.start(task, meta, {tabId}) -> Job   validate, queue, dispatch to the host (maxConcurrent 1..4); a tab may
 *                                            have at most config.maxActivePerTab jobs queued or running (too_many_jobs)
 *   AYT.jobs.cancel(id) / retry(id, {tabId}) -> Job / remove(id) / clear() -> count / open(id, 'file'|'folder')
 *   AYT.jobs.label(job) -> string            the job's label in the current UI language (AYT.util.jobLabel when present)
 *   AYT.jobs.list() -> Job[] (newest first)  AYT.jobs.get(id)
 *   AYT.jobs.view(job) / views() -> the UI copy of a job / of the list (what pushes, snapshots and JOBS_LIST carry)
 *
 * Job = { id, kind, videoId, title, label, thumbnail, status:'queued'|'starting'|'running'|'processing'|'done'|'error'|'canceled',
 *         stage, percent, downloaded, total, speed, eta, playlist:{index,count,title}|null, files:[{path,size}],
 *         filePath, fileSize, fileCount, failedItems, error, errorCode, errorDetail, task, meta, createdAt, updatedAt, finishedAt }
 * fileCount / failedItems: playlist jobs only (done event); failedItems > 0 = some items could not be downloaded.
 * error: job.err.<code> + the host's reason line with absolute paths hidden (YouTube shows it, spec §0.6);
 * errorDetail: the host's raw text (stays in the service worker).
 *
 * UI pushes are throttled to 4/s per job (status changes go out immediately) and carry view(job): the job without
 * files[] (up to 1000 paths for a playlist), meta, errorDetail and titlePending, which no UI reads.
 * The list is persisted (throttled 1 s) in IndexedDB ('ayt-jobs'), not in chrome.storage.local: every
 * chrome.storage write is delivered (old + new value) to each YouTube tab and extension page with a storage
 * listener, and chrome.storage.local.get(null) would load the history too. chrome.storage.local['jobs'] is only the
 * fallback when IndexedDB is unavailable, and is migrated into IndexedDB on start. Jobs that were active when the
 * service worker died are marked as failed with t('job.interrupted') on the next start. Cookies are never stored or pushed.
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  const U = AYT.util;
  const t = (key, params) => AYT.t(key, params);
  const E = (code, message, extra) => AYT.bg.error(code, message, extra);

  const ACTIVE = ['queued', 'starting', 'running', 'processing'];
  const HOST_ACTIVE = ['starting', 'running', 'processing'];
  const STATUSES = ACTIVE.concat(AYT.JOB_DONE_STATES);
  const PROGRESS_STAGES = ['video', 'audio', 'download', 'subtitles'];
  const PROCESS_STAGES = ['merge', 'extract', 'thumbnail', 'metadata', 'cut', 'gif', 'subtitles', 'convert', 'processing'];
  /** Host events that mean a job is still running there. */
  const STRAY_EVENTS = ['info', 'progress', 'stage', 'file'];
  const NOTIFY_PREFIX = 'ayt-job:';
  const JOB_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

  /** Tunables (tests shorten them). */
  const config = {
    pushIntervalMs: 250,
    persistIntervalMs: 1000,
    cancelGraceMs: 20000,
    strayCancelMs: 5000, // at most one 'cancel' per this interval for a job the host still reports but we dropped
    // Jobs one tab may have queued or running at once: a page (or anything that drives our UI in it) cannot fill the
    // queue and the disk with hundreds of downloads. Jobs from the popup and the context menu have no tab.
    maxActivePerTab: 20,
  };

  /** Fields no UI context reads: kept in the service worker (and persisted), left out of view(job). */
  const VIEW_OMIT = ['files', 'meta', 'errorDetail', 'titlePending'];
  /** A finished playlist keeps its last files only in the persisted history (open() uses filePath / the last file). */
  const PERSIST_MAX_FILES = 50;

  const jobs = new Map(); // id -> Job (JSON-safe plain object)
  // id -> { lastPush, pushTimer, pushedStatus, sent, started, cancelRequested, cancelSent, cancelTimer, tabId }
  // (tabId: the tab whose UI started the job, null for the popup / context menu; not persisted, not pushed)
  const runtime = new Map();
  const strayCancels = new Map(); // jobId -> last time a 'cancel' was sent for host events of a job we no longer run
  let persistTimer = 0;
  let lastPersist = 0;
  let persistDirty = false;
  let lastBadge = null;
  let titleOverridden = false;

  /* ------------------------------------------------------------------ helpers */

  function rt(id) {
    let r = runtime.get(id);
    if (!r) {
      r = { lastPush: 0, pushTimer: 0, pushedStatus: null, sent: false, started: false, cancelRequested: false, cancelSent: false, cancelTimer: 0, tabId: null };
      runtime.set(id, r);
    }
    return r;
  }

  function dropRuntime(id) {
    const r = runtime.get(id);
    if (!r) return;
    clearTimeout(r.pushTimer);
    clearTimeout(r.cancelTimer);
    runtime.delete(id);
  }

  function isTerminal(job) {
    return AYT.JOB_DONE_STATES.includes(job.status);
  }

  function isActive(job) {
    return ACTIVE.includes(job.status);
  }

  function num(v, min, max) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    if (!isFinite(n)) return null;
    return Math.min(max == null ? Infinity : max, Math.max(min == null ? -Infinity : min, n));
  }

  function str(v, max) {
    return typeof v === 'string' && v ? v.slice(0, max) : null;
  }

  function list() {
    return Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  function get(id) {
    return typeof id === 'string' ? jobs.get(id) || null : null;
  }

  /**
   * The copy of a job that UI contexts get (pushes, port snapshots, JOBS_LIST, JOB_START): every field the job list,
   * the panels and AYT.client read (status, stage, percent, speed, eta, downloaded, total, playlist, filePath,
   * fileSize, fileCount, failedItems, error, errorCode, title, label, kind, videoId, thumbnail, task, timestamps),
   * without files[] / meta / errorDetail / titlePending.
   */
  function view(job) {
    const out = {};
    for (const k of Object.keys(job)) if (!VIEW_OMIT.includes(k)) out[k] = job[k];
    return out;
  }

  function views() {
    return list().map(view);
  }

  function mustGet(id) {
    if (typeof id !== 'string' || !JOB_ID_RE.test(id)) throw E('bad_request', t('background.err.badRequest'));
    const job = jobs.get(id);
    if (!job) throw E('not_found', t('background.err.notFound'));
    return job;
  }

  function hostActiveCount() {
    let n = 0;
    for (const job of jobs.values()) if (HOST_ACTIVE.includes(job.status)) n++;
    return n;
  }

  function activeCount() {
    let n = 0;
    for (const job of jobs.values()) if (isActive(job)) n++;
    return n;
  }

  /** Queued + running jobs started from one tab. */
  function activeCountForTab(tabId) {
    let n = 0;
    for (const job of jobs.values()) {
      const r = runtime.get(job.id);
      if (r && r.tabId === tabId && isActive(job)) n++;
    }
    return n;
  }

  /** The sender's tab id ({ tabId } from the router), or null (popup, options without a tab, context menu). */
  function originTab(origin) {
    const id = origin && origin.tabId;
    return typeof id === 'number' && Number.isInteger(id) && id >= 0 ? id : null;
  }

  /** Throws too_many_jobs when the tab already has config.maxActivePerTab jobs queued or running. */
  function checkTabLimit(tabId) {
    if (tabId === null) return;
    const max = config.maxActivePerTab;
    if (activeCountForTab(tabId) >= max) throw E('too_many_jobs', t('background.err.tooManyJobs', { max }));
  }

  /**
   * The job's label in the current UI language: AYT.util.jobLabel rebuilds it from job.task (a newer shared helper,
   * used when present); otherwise the label the UI sent when the job was created.
   */
  function label(job) {
    if (typeof U.jobLabel === 'function') {
      try {
        const s = U.jobLabel(job);
        if (typeof s === 'string' && s) return s;
      } catch (e) {
        console.warn('[AYT] job label failed', e);
      }
    }
    return job.label || '';
  }

  /**
   * job.error is shown inside our open shadow roots on YouTube, where page scripts can read it (spec §0.6): every
   * absolute path in the host's reason (its folders hold the Windows user name) is cut to its last name, and a path
   * that could be the user's own folder (C:\Users\<name>, \\server\share\<name>) becomes '…'. One rule for the whole
   * extension: AYT.util.hidePaths (ui.jobItem applies it again, which changes nothing). errorDetail keeps the raw
   * text (it is never pushed).
   */
  const hidePaths = (text) => U.hidePaths(text);

  /** Short, single-line reason from a yt-dlp/host message ("ERROR: [youtube] id: Video unavailable..."), without paths. */
  function reasonLine(detail) {
    const lines = String(detail || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const line = lines.find((l) => /^ERROR:/i.test(l)) || lines[0] || '';
    // Paths are hidden before the cut: a path cut in half would no longer be recognized.
    return hidePaths(line.replace(/^ERROR:\s*/i, '').replace(/^\[[\w:-]+\]\s*(?:[\w-]{11}:\s*)?/, ''))
      .slice(0, 240)
      .trim();
  }

  /** Friendly text for an error code + optional raw detail from the host (spec: job.err.<code>). */
  function describeError(code, detail) {
    let key = code === 'interrupted' ? 'job.interrupted' : 'job.err.' + code;
    if (!AYT.i18n.has(key)) key = 'job.err.unknown';
    const friendly = t(key);
    if (!detail || /^(host_\w+|timeout|interrupted|bad_folder)$/.test(code)) return friendly;
    const reason = reasonLine(detail);
    return reason && reason !== friendly && !friendly.includes(reason) ? friendly + ' — ' + reason : friendly;
  }

  /* ------------------------------------------------------------------ pushes, persistence, badge */

  function pushNow(job) {
    const r = rt(job.id);
    clearTimeout(r.pushTimer);
    r.pushTimer = 0;
    r.lastPush = Date.now();
    r.pushedStatus = job.status;
    AYT.bg.broadcast({ type: AYT.PUSH.JOB, job: view(job) });
  }

  /**
   * Records a change: pushes to UI ports (throttled unless the status changed) and schedules persistence.
   * @param {object} job
   * @param {{important?: boolean, immediate?: boolean}} [opts] important = worth persisting (not just progress)
   */
  function changed(job, opts) {
    const o = opts || {};
    job.updatedAt = Date.now();
    const r = rt(job.id);
    const now = Date.now();
    if (o.immediate || r.pushedStatus !== job.status || now - r.lastPush >= config.pushIntervalMs) pushNow(job);
    else if (!r.pushTimer) {
      r.pushTimer = setTimeout(() => {
        r.pushTimer = 0;
        if (jobs.get(job.id) === job) pushNow(job);
      }, Math.max(10, config.pushIntervalMs - (now - r.lastPush)));
    }
    if (o.important) schedulePersist();
  }

  function schedulePersist() {
    persistDirty = true;
    if (persistTimer) return;
    const wait = Math.max(0, config.persistIntervalMs - (Date.now() - lastPersist));
    persistTimer = setTimeout(persistNow, wait);
  }

  function persistNow() {
    clearTimeout(persistTimer);
    persistTimer = 0;
    if (!persistDirty) return Promise.resolve();
    persistDirty = false;
    lastPersist = Date.now();
    return store.save(list().slice(0, AYT.LIMITS.MAX_JOBS_KEPT).map(persisted)).catch((e) => {
      console.warn('[AYT] saving jobs failed', e);
    });
  }

  /** The stored copy of a job: a playlist keeps only its last files (it can list up to 1000; fileCount has the total). */
  function persisted(job) {
    if (!Array.isArray(job.files) || job.files.length <= PERSIST_MAX_FILES) return job;
    return Object.assign({}, job, { files: job.files.slice(-PERSIST_MAX_FILES) });
  }

  function broadcastSnapshot() {
    AYT.bg.broadcast({ type: AYT.PUSH.JOBS, jobs: views() });
  }

  /* ------------------------------------------------------------------ job history store */

  /**
   * IndexedDB 'ayt-jobs' / store 'kv' / key 'jobs' holds the persisted list (newest first). IndexedDB writes are
   * private to the service worker; chrome.storage.local['jobs'] (the format of older versions) is used only when
   * IndexedDB is missing or fails, and is merged into IndexedDB and removed on the next start.
   */
  const store = (() => {
    const DB_NAME = 'ayt-jobs';
    const STORE = 'kv';
    const KEY = 'jobs';
    const LEGACY_KEY = AYT.STORAGE.JOBS;
    let useIdb = null; // null = not decided yet (load() decides)
    let dbPromise = null;
    let legacyPresent = false; // chrome.storage.local still has a list that must be removed once IndexedDB has the data

    function idbAvailable() {
      try {
        return !!(g.indexedDB && typeof g.indexedDB.open === 'function');
      } catch (_) {
        return false;
      }
    }

    function open() {
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const req = g.indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
          };
          req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => {
              db.close();
              dbPromise = null;
            };
            resolve(db);
          };
          req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
          req.onblocked = () => reject(new Error('IndexedDB open blocked'));
        });
        dbPromise.catch(() => {
          dbPromise = null;
        });
      }
      return dbPromise;
    }

    /** One request in its own transaction; resolves with its result once the transaction has committed. */
    function run(mode, makeRequest) {
      return open().then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const req = makeRequest(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(req.result);
            tx.onabort = () => reject(tx.error || req.error || new Error('IndexedDB transaction aborted'));
            if (mode === 'readwrite' && typeof tx.commit === 'function') tx.commit();
          })
      );
    }

    function fallBack(e) {
      if (useIdb) console.warn('[AYT] job history: IndexedDB failed, using chrome.storage.local instead', e);
      useIdb = false;
    }

    /** -> Job[] | null (raw stored objects, newest first) and whether the list must be written back. */
    async function load() {
      if (useIdb === null) useIdb = idbAvailable();
      let fromIdb = null;
      if (useIdb) {
        try {
          fromIdb = await run('readonly', (s) => s.get(KEY));
        } catch (e) {
          fallBack(e);
        }
      }
      let legacy = null;
      try {
        legacy = (await chrome.storage.local.get(LEGACY_KEY))[LEGACY_KEY];
      } catch (e) {
        console.warn('[AYT] loading jobs failed', e);
      }
      if (!useIdb) return { list: Array.isArray(legacy) ? legacy : null, rewrite: false };
      if (!Array.isArray(legacy)) return { list: Array.isArray(fromIdb) ? fromIdb : null, rewrite: false };
      // A list in chrome.storage.local (an older version, or a session where IndexedDB failed): merge it in, the
      // newest copy of each job wins; it is written to IndexedDB and the old key is removed.
      legacyPresent = true;
      const byId = new Map();
      for (const j of (Array.isArray(fromIdb) ? fromIdb : []).concat(legacy)) {
        if (!j || typeof j !== 'object' || typeof j.id !== 'string') continue;
        const prev = byId.get(j.id);
        if (!prev || (Number(j.updatedAt) || 0) > (Number(prev.updatedAt) || 0)) byId.set(j.id, j);
      }
      const merged = Array.from(byId.values()).sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
      return { list: merged, rewrite: true };
    }

    async function save(data) {
      if (useIdb === null) useIdb = idbAvailable();
      if (useIdb) {
        try {
          await run('readwrite', (s) => s.put(data, KEY));
          if (legacyPresent) {
            legacyPresent = false;
            await chrome.storage.local.remove(LEGACY_KEY).catch((e) => console.warn('[AYT] removing the old job list failed', e));
          }
          return;
        } catch (e) {
          fallBack(e);
        }
      }
      await chrome.storage.local.set({ [LEGACY_KEY]: data });
    }

    return {
      load,
      save,
      get backend() {
        return useIdb === null ? 'unknown' : useIdb ? 'indexeddb' : 'storage';
      },
    };
  })();

  function updateBadge(force) {
    const n = activeCount();
    const text = n > 0 ? String(n) : '';
    if (text === lastBadge && !force) return;
    lastBadge = text;
    try {
      AYT.bg.quiet(chrome.action.setBadgeBackgroundColor({ color: '#e53935' }));
      if (chrome.action.setBadgeTextColor) AYT.bg.quiet(chrome.action.setBadgeTextColor({ color: '#ffffff' }));
      AYT.bg.quiet(chrome.action.setBadgeText({ text }));
      if (n > 0) {
        titleOverridden = true;
        AYT.bg.quiet(chrome.action.setTitle({ title: t('background.badgeTitle', { count: n }) }));
      } else if (titleOverridden) {
        titleOverridden = false;
        AYT.bg.quiet(chrome.action.setTitle({ title: chrome.i18n.getMessage('actionTitle') || "Akif's Special YouTube Addon" }));
      }
    } catch (e) {
      console.warn('[AYT] badge update failed', e);
    }
  }

  /* ------------------------------------------------------------------ notifications */

  function fileName(path) {
    return String(path || '').split(/[\\/]/).pop();
  }

  function notifyFinished(job) {
    if (!AYT.settings.get('notifyOnComplete')) return;
    const what = label(job); // in the current UI language
    const title = job.title || what || job.videoId || '';
    if (job.status === 'done') {
      // A playlist runs with --ignore-errors: the host reports the items it could not download in done.failedItems.
      const partial = job.failedItems > 0;
      const opts = {
        title: partial ? t('job.completedPartial', { title }) : t('job.completed', { title }),
        message: partial
          ? t('job.partialSummary', { done: job.fileCount != null ? job.fileCount : job.files.length, failed: job.failedItems })
          : fileName(job.filePath) || what || title,
        contextMessage: [what, U.formatBytes(job.fileSize)].filter(Boolean).join(' · '),
      };
      if (job.filePath) opts.buttons = [{ title: t('job.openFile') }, { title: t('job.showInFolder') }];
      AYT.bg.notify(NOTIFY_PREFIX + job.id, opts);
    } else if (job.status === 'error') {
      AYT.bg.notify(NOTIFY_PREFIX + job.id, { title: t('job.failed', { title }), message: job.error || t('job.err.unknown') });
    }
  }

  async function onNotificationClicked(id, button) {
    if (typeof id !== 'string' || !id.startsWith(NOTIFY_PREFIX)) return;
    AYT.bg.clearNotification(id);
    await AYT.bgReady;
    const job = jobs.get(id.slice(NOTIFY_PREFIX.length));
    if (!job) return;
    try {
      if (job.status === 'done') await open(job.id, button === 1 ? 'folder' : 'file');
      else if (job.status === 'error' && /^host_/.test(job.errorCode || '')) await AYT.bg.openOptions('companion');
      else if (job.status === 'error' && job.errorCode === 'bad_folder') await AYT.bg.openOptions('downloads');
    } catch (e) {
      AYT.bg.notify('ayt-open-failed', { title: job.title || label(job) || t('common.error'), message: (e && e.message) || String(e) });
    }
  }

  /* ------------------------------------------------------------------ state transitions */

  function setStatus(job, status) {
    if (job.status === status) return changed(job);
    job.status = status;
    changed(job, { important: true, immediate: true });
    updateBadge();
  }

  function finish(job, status) {
    if (isTerminal(job)) return;
    job.status = status;
    job.finishedAt = Date.now();
    job.speed = null;
    job.eta = null;
    if (status === 'done') {
      job.percent = 100;
      job.stage = null;
    }
    const r = runtime.get(job.id);
    if (r) {
      clearTimeout(r.cancelTimer);
      r.cancelTimer = 0;
    }
    changed(job, { important: true, immediate: true });
    updateBadge();
    notifyFinished(job);
    pump();
    AYT.native.scheduleIdle();
  }

  function fail(job, code, detail) {
    if (isTerminal(job)) return;
    job.errorCode = String(code || 'unknown').slice(0, 40);
    job.errorDetail = detail ? String(detail).slice(0, 2000) : null;
    job.error = describeError(job.errorCode, job.errorDetail);
    finish(job, 'error');
  }

  /* ------------------------------------------------------------------ queue */

  function maxConcurrent() {
    const n = Math.round(Number(AYT.settings.get('maxConcurrent')));
    return U.clamp(isFinite(n) ? n : 2, 1, 4);
  }

  /** Starts queued jobs (oldest first) while fewer than maxConcurrent jobs are with the host. */
  function pump() {
    let running = hostActiveCount();
    const max = maxConcurrent();
    if (running >= max) return;
    const queued = Array.from(jobs.values())
      .filter((j) => j.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const job of queued) {
      if (running >= max) break;
      running++;
      dispatch(job).catch((e) => console.error('[AYT] dispatch failed', e));
    }
  }

  async function cookiesText() {
    if (!AYT.settings.get('useCookies')) return null;
    try {
      const cookies = await chrome.cookies.getAll({ domain: 'youtube.com' });
      return cookies && cookies.length ? AYT.task.cookiesToNetscape(cookies) : null;
    } catch (e) {
      console.warn('[AYT] reading YouTube cookies failed', e);
      return null;
    }
  }

  function stillStarting(job) {
    return jobs.get(job.id) === job && job.status === 'starting';
  }

  async function dispatch(job) {
    const r = rt(job.id);
    r.sent = false;
    r.started = false;
    r.cancelRequested = false;
    r.cancelSent = false;
    job.error = null;
    job.errorCode = null;
    job.errorDetail = null;
    setStatus(job, 'starting');
    try {
      if (!AYT.native.connected && AYT.native.status.state !== 'connected') {
        const st = await AYT.native.check(true);
        if (!stillStarting(job)) return;
        // host_missing / host_forbidden / host_policy (blocked by the administrator) / host_outdated / host_error
        if (st.state !== 'connected') throw E(AYT.native.statusCode(st), st.error || '');
      }
      const cookies = await cookiesText();
      if (!stillStarting(job)) return;
      const hostTask = AYT.task.buildHostTask(job.task, AYT.settings.all(), cookies, AYT.i18n.language);
      r.sent = true;
      await AYT.native.request('start', { jobId: job.id, task: hostTask });
      r.started = true;
      if (jobs.get(job.id) !== job || isTerminal(job)) {
        // Removed meanwhile: a cancel the host answered with found:false had overtaken the start, send it again.
        if (r.cancelRequested && !r.cancelSent) hostCancel(job.id);
        return;
      }
      if (job.status === 'starting') setStatus(job, 'running');
      if (r.cancelRequested) sendCancel(job); // no-op when the first cancel reached the job
    } catch (e) {
      const code = (e && e.code) || 'unknown';
      // The host may have accepted the job even though its answer timed out: make sure it stops (if it registers the
      // job even later, its first event triggers another cancel, see onHostEvent).
      if (r.sent && code === 'timeout') hostCancel(job.id);
      if (jobs.get(job.id) !== job || isTerminal(job)) return;
      if (r.cancelRequested) return finish(job, 'canceled');
      fail(job, code, (e && (e.detail || e.message)) || '');
    }
  }

  /**
   * Sends 'cancel' for a job id. Resolves true when the host knew the job, false when it answered found:false,
   * null when there was no answer (host gone, error). Never rejects.
   */
  function hostCancel(id) {
    return AYT.native.request('cancel', { jobId: id }).then(
      (res) => !(res && res.found === false),
      () => null
    );
  }

  /** Asks the host to stop a job; it ends with the host's 'canceled' event (or as canceled after cancelGraceMs). */
  function sendCancel(job) {
    const r = rt(job.id);
    if (r.cancelSent) return;
    r.cancelSent = true;
    hostCancel(job.id).then((found) => {
      if (jobs.get(job.id) !== job || isTerminal(job)) return;
      if (found === null) finish(job, 'canceled'); // host gone or job unknown to it: nothing is running any more
      else if (found === false) {
        // The host registers a job only after preparing its folder, and handles requests concurrently: a cancel that
        // arrives before that finds nothing. dispatch() sends it again once the start is confirmed.
        if (!r.started) r.cancelSent = false;
        else finish(job, 'canceled'); // started, and the host has no such job any more
      }
    });
    clearTimeout(r.cancelTimer);
    r.cancelTimer = setTimeout(() => {
      if (jobs.get(job.id) === job && !isTerminal(job)) finish(job, 'canceled');
    }, config.cancelGraceMs);
  }

  /** The host reports progress for a job we dropped or ended (removed, canceled, failed while its start was late): stop it. */
  function cancelStray(jobId) {
    if (!JOB_ID_RE.test(jobId)) return;
    const now = Date.now();
    const last = strayCancels.get(jobId);
    if (last && now - last < config.strayCancelMs) return;
    strayCancels.delete(jobId);
    strayCancels.set(jobId, now);
    while (strayCancels.size > 50) strayCancels.delete(strayCancels.keys().next().value);
    hostCancel(jobId);
  }

  /* ------------------------------------------------------------------ host events */

  function onHostEvent(msg) {
    const id = typeof msg.jobId === 'string' ? msg.jobId : null;
    const job = id ? jobs.get(id) : null;
    if (!job || isTerminal(job)) {
      // Still running at the host although it is gone or over here (a done job has nothing left to stop).
      if (id && STRAY_EVENTS.includes(msg.event) && !(job && job.status === 'done')) cancelStray(id);
      else if (id) strayCancels.delete(id);
      return;
    }
    switch (msg.event) {
      case 'info': {
        const title = str(msg.title, 300);
        if (job.playlist) {
          job.playlist = Object.assign({}, job.playlist, {
            index: num(msg.playlistIndex, 1, 1e6) || job.playlist.index,
            count: num(msg.playlistCount, 1, 1e6) || job.playlist.count,
            title: str(msg.playlistTitle, 300) || job.playlist.title,
          });
          if (job.titlePending && (msg.playlistTitle || title)) {
            job.title = str(msg.playlistTitle, 300) || title;
            job.titlePending = false;
          }
        } else if (job.titlePending && title) {
          job.title = title;
          job.titlePending = false;
        }
        if (!job.videoId && typeof msg.videoId === 'string' && AYT.task.VIDEO_ID_RE.test(msg.videoId)) job.videoId = msg.videoId;
        changed(job, { important: true, immediate: true });
        break;
      }
      case 'progress': {
        job.stage = PROGRESS_STAGES.includes(msg.stage) ? msg.stage : 'download';
        const percent = num(msg.percent, 0, 100);
        if (percent !== null) job.percent = Math.round(percent * 10) / 10;
        job.downloaded = num(msg.downloaded, 0);
        job.total = num(msg.total, 0);
        job.speed = num(msg.speed, 0);
        job.eta = num(msg.eta, 0);
        if (job.playlist && (msg.playlistIndex != null || msg.playlistCount != null)) {
          job.playlist = Object.assign({}, job.playlist, {
            index: num(msg.playlistIndex, 1, 1e6) || job.playlist.index,
            count: num(msg.playlistCount, 1, 1e6) || job.playlist.count,
          });
        }
        if (job.status !== 'running') setStatus(job, 'running');
        else changed(job);
        break;
      }
      case 'stage': {
        job.stage = PROCESS_STAGES.includes(msg.stage) ? msg.stage : 'processing';
        job.speed = null;
        job.eta = null;
        // The host attaches the overall percent reached so far (its progress events are rate-limited).
        const stagePercent = num(msg.percent, 0, 100);
        if (stagePercent !== null && (job.percent == null || stagePercent > job.percent)) job.percent = Math.round(stagePercent * 10) / 10;
        if (job.status !== 'processing') setStatus(job, 'processing');
        else changed(job, { immediate: true });
        break;
      }
      case 'file': {
        const path = str(msg.path, 1024);
        if (path && !job.files.some((f) => f.path === path) && job.files.length < 1000) {
          job.files.push({ path, size: num(msg.size, 0) });
          changed(job, { important: true });
        }
        break;
      }
      case 'done': {
        if (Array.isArray(msg.files)) {
          const files = msg.files
            .filter((f) => f && typeof f.path === 'string' && f.path)
            .slice(0, 1000)
            .map((f) => ({ path: f.path.slice(0, 1024), size: num(f.size, 0) }));
          if (files.length) job.files = files;
        }
        const last = job.files.length ? job.files[job.files.length - 1] : null;
        job.filePath = str(msg.filePath, 1024) || (last && last.path) || null;
        job.fileSize = num(msg.fileSize, 0);
        if (job.fileSize === null && job.files.length) {
          const sum = job.files.reduce((a, f) => a + (f.size || 0), 0);
          job.fileSize = sum > 0 ? sum : null;
        }
        if (job.playlist) {
          // Playlists run with --ignore-errors: fileCount = files written (files[] may be truncated), failedItems =
          // items that failed (about one yt-dlp ERROR line each).
          const count = num(msg.fileCount, 0, 1e6);
          job.fileCount = count !== null ? Math.round(count) : job.files.length;
          job.failedItems = Math.round(num(msg.failedItems, 0, 1e6) || 0);
        }
        finish(job, 'done');
        break;
      }
      case 'error': {
        const code = typeof msg.code === 'string' && /^[a-z0-9_]{1,40}$/.test(msg.code) ? msg.code : 'unknown';
        const detail = [msg.message, msg.detail].filter((x) => typeof x === 'string' && x).join('\n');
        if (rt(job.id).cancelRequested) finish(job, 'canceled');
        else fail(job, code, detail);
        break;
      }
      case 'canceled':
        finish(job, 'canceled');
        break;
      default:
        break;
    }
  }

  function onHostDisconnect(code, message) {
    for (const job of Array.from(jobs.values())) {
      if (!HOST_ACTIVE.includes(job.status)) continue;
      const r = rt(job.id);
      if (job.status === 'starting' && !r.sent) continue; // dispatch has not talked to the host yet
      if (r.cancelRequested) finish(job, 'canceled');
      else fail(job, /^host_(missing|forbidden|policy|error)$/.test(code) ? code : 'host_exit', message);
    }
  }

  /* ------------------------------------------------------------------ public actions */

  function createJob(task, meta) {
    const now = Date.now();
    const titlePending = !meta.title;
    return {
      id: U.uuid(),
      kind: task.kind,
      videoId: task.videoId || meta.videoId || null,
      title: meta.title || (task.videoId ? t('background.videoFallbackTitle', { id: task.videoId }) : ''),
      titlePending,
      label: meta.label || '',
      thumbnail: meta.thumbnail || null,
      status: 'queued',
      stage: null,
      percent: null,
      downloaded: null,
      total: null,
      speed: null,
      eta: null,
      playlist: task.playlist ? { index: null, count: null, title: meta.title || null } : null,
      files: [],
      filePath: null,
      fileSize: null,
      fileCount: null,
      failedItems: 0,
      error: null,
      errorCode: null,
      errorDetail: null,
      task,
      meta,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
  }

  /** Keeps at most MAX_JOBS_KEPT jobs (oldest finished ones go first; active jobs are never dropped). */
  function trim() {
    const max = AYT.LIMITS.MAX_JOBS_KEPT;
    if (jobs.size <= max) return;
    const old = Array.from(jobs.values())
      .filter(isTerminal)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const job of old) {
      if (jobs.size <= max) break;
      jobs.delete(job.id);
      dropRuntime(job.id);
      AYT.bg.broadcast({ type: AYT.PUSH.JOB_REMOVED, jobId: job.id });
    }
  }

  function add(job, tabId) {
    jobs.set(job.id, job);
    rt(job.id).tabId = tabId === undefined ? null : tabId;
    trim();
    changed(job, { important: true, immediate: true });
    updateBadge();
    pump();
    return job;
  }

  /**
   * Validates and queues a companion job.
   * @param {object} task untrusted task from the UI (spec §8.3)
   * @param {object} meta untrusted display metadata { title, videoId, thumbnail, label }
   * @param {{tabId?: number}} [origin] the sender's tab: at most config.maxActivePerTab active jobs per tab
   * @returns {object} the new job
   * @throws Error with code bad_task (invalid task) or too_many_jobs
   */
  function start(task, meta, origin) {
    const clean = AYT.task.validate(task);
    const tabId = originTab(origin);
    checkTabLimit(tabId);
    return add(createJob(clean, AYT.task.validateMeta(meta, clean)), tabId);
  }

  /** Cancels a job: queued -> canceled now; running -> host 'cancel' (then the host's 'canceled' event). */
  function cancel(id) {
    const job = mustGet(id);
    if (isTerminal(job)) return job;
    const r = rt(job.id);
    r.cancelRequested = true;
    if (job.status === 'queued' || !r.sent) finish(job, 'canceled');
    else sendCancel(job);
    return job;
  }

  /** New job from the same task/meta; the old (finished) one is removed. origin: as for start(). */
  function retry(id, origin) {
    const old = mustGet(id);
    if (!isTerminal(old)) throw E('bad_state', t('background.err.stillRunning'));
    const task = AYT.task.validate(old.task);
    const meta = AYT.task.validateMeta(old.meta, task);
    const tabId = originTab(origin);
    checkTabLimit(tabId);
    removeJob(old);
    return add(createJob(task, meta), tabId);
  }

  function removeJob(job) {
    jobs.delete(job.id);
    dropRuntime(job.id);
    AYT.bg.clearNotification(NOTIFY_PREFIX + job.id);
    AYT.bg.broadcast({ type: AYT.PUSH.JOB_REMOVED, jobId: job.id });
    schedulePersist();
    updateBadge();
  }

  /** Removes a job (an active one is canceled first). */
  function remove(id) {
    const job = mustGet(id);
    if (isActive(job)) {
      const r = rt(job.id);
      r.cancelRequested = true;
      if (r.sent && HOST_ACTIVE.includes(job.status) && !r.cancelSent) {
        r.cancelSent = true;
        // found:false before the start is confirmed: dispatch() sends the cancel again once it is (see sendCancel)
        hostCancel(job.id).then((found) => {
          if (found === false && !r.started) r.cancelSent = false;
        });
      }
    }
    removeJob(job);
    pump();
    AYT.native.scheduleIdle();
  }

  /** Removes every finished/failed/canceled job. Returns how many were removed. */
  function clear() {
    let n = 0;
    for (const job of Array.from(jobs.values())) {
      if (!isTerminal(job)) continue;
      jobs.delete(job.id);
      dropRuntime(job.id);
      AYT.bg.clearNotification(NOTIFY_PREFIX + job.id);
      n++;
    }
    if (n) {
      broadcastSnapshot();
      schedulePersist();
    }
    return n;
  }

  /** Asks the host to open the job's own file (or reveal it in its folder). Never takes a path from a message. */
  async function open(id, target) {
    const job = mustGet(id);
    const tgt = target === 'folder' ? 'folder' : 'file';
    const last = job.files.length ? job.files[job.files.length - 1].path : null;
    const path = job.filePath || last;
    if (job.status !== 'done' || !path) throw E('not_ready', t('background.err.noFile'));
    await AYT.native.requestFriendly('open', { path, target: tgt }, null, 'background.err.openFailed');
  }

  /* ------------------------------------------------------------------ lifecycle */

  function revive(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !JOB_ID_RE.test(raw.id)) return null;
    if (!AYT.JOB_KINDS.includes(raw.kind) || !STATUSES.includes(raw.status)) return null;
    const job = Object.assign(createJob({ kind: raw.kind, videoId: null, playlist: false }, { title: '', label: '' }), raw);
    job.files = Array.isArray(raw.files) ? raw.files.filter((f) => f && typeof f.path === 'string') : [];
    if (typeof job.createdAt !== 'number') job.createdAt = 0;
    if (!job.task || typeof job.task !== 'object') job.task = { kind: raw.kind };
    if (!job.meta || typeof job.meta !== 'object') job.meta = {};
    return job;
  }

  async function init() {
    let stored = null;
    let rewrite = false;
    try {
      ({ list: stored, rewrite } = await store.load());
    } catch (e) {
      console.warn('[AYT] loading jobs failed', e);
    }
    let interrupted = 0;
    let redescribed = 0;
    if (Array.isArray(stored)) {
      for (const raw of stored.slice(0, AYT.LIMITS.MAX_JOBS_KEPT)) {
        const job = revive(raw);
        if (!job || jobs.has(job.id)) continue;
        if (isActive(job)) {
          job.status = 'error';
          job.errorCode = 'interrupted';
          job.errorDetail = null;
          job.error = describeError('interrupted');
          job.finishedAt = Date.now();
          job.speed = null;
          job.eta = null;
          interrupted++;
        } else if (job.status === 'error' && job.errorCode) {
          // Described again: a text stored by an older version may still name an absolute path (see hidePaths).
          const text = describeError(job.errorCode, job.errorDetail);
          if (text !== job.error) {
            job.error = text;
            redescribed++;
          }
        }
        jobs.set(job.id, job);
      }
    }
    if (interrupted || redescribed || rewrite) {
      persistDirty = true;
      await persistNow();
    }
    updateBadge(true);
  }

  /** Re-translates stored error texts after a UI language change and re-sends the list. */
  function relocalize() {
    for (const job of jobs.values()) {
      if (job.status === 'error' && job.errorCode) job.error = describeError(job.errorCode, job.errorDetail);
    }
    updateBadge(true);
    broadcastSnapshot();
  }

  AYT.native.onEvent(onHostEvent);
  AYT.native.onDisconnect(onHostDisconnect);
  AYT.native.setBusyCheck(() => hostActiveCount() > 0);

  // Registered synchronously at load (service-worker top level) so clicks wake the worker.
  try {
    chrome.notifications.onClicked.addListener((id) => {
      onNotificationClicked(id, -1).catch(() => {});
    });
    chrome.notifications.onButtonClicked.addListener((id, index) => {
      onNotificationClicked(id, index).catch(() => {});
    });
  } catch (e) {
    console.warn('[AYT] notifications unavailable', e);
  }

  AYT.jobs = {
    config,
    init,
    list,
    get,
    view,
    views,
    /** 'indexeddb' | 'storage' (chrome.storage.local fallback) | 'unknown' (before init) */
    get storageBackend() {
      return store.backend;
    },
    start,
    cancel,
    retry,
    remove,
    clear,
    open,
    pump,
    relocalize,
    describeError,
    label,
    activeCount,
    activeCountForTab,
    hostActiveCount,
    persistNow: () => {
      persistDirty = true;
      return persistNow();
    },
    isValidId: (id) => typeof id === 'string' && JOB_ID_RE.test(id),
  };
})(globalThis);
