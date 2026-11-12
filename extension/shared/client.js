/*
 * Akif's Special YouTube Addon — client for talking to the service worker.
 * Used by content scripts, the popup and the options page.
 *
 *   const res = await AYT.client.send(AYT.MSG.JOB_START, { task, meta });   // throws on { ok:false }
 *   AYT.client.on('jobs', (jobs) => ...);      // 'jobs' | 'job' | 'host' | 'command' | 'invalidated'
 *   AYT.client.retain(); ... AYT.client.release();   // keep a live update port open while UI is visible
 *
 * The live port is only held while something needs live updates (an open panel/popup, or an
 * active job known to this context). An idle port would make the service worker wake up in a loop:
 * Chrome stops an idle worker after ~30 s, which closes the port. Without an active job the port is
 * therefore reopened on the next user activity (pointer, key, focus, tab shown), not right away.
 *
 * Errors thrown by send() carry a localized message and a .code ('invalidated' when the extension was
 * reloaded/updated, 'no_response'/'runtime' when the background can't be reached; Chrome's own text is in .detail).
 */
(function (g) {
  'use strict';
  const AYT = (g.AYT = g.AYT || {});
  if (AYT.client) return;

  const listeners = new Map(); // event -> Set<fn>
  const jobs = new Map(); // id -> Job
  let port = null;
  let explicitRetains = 0;
  let autoRetained = false;
  let reconnectTimer = 0;
  let backoff = 400;
  let hostStatus = null;
  let invalidated = false;
  let stale = false; // the port closed while only open UI wanted it: reopen it on the next user activity

  function contextValid() {
    try {
      return !!(g.chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function emit(event, data, extra) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(data, extra);
      } catch (e) {
        console.error('[AYT] listener error', event, e);
      }
    }
  }

  function markInvalid() {
    if (invalidated) return;
    invalidated = true;
    port = null;
    clearTimeout(reconnectTimer);
    emit('invalidated', true);
  }

  function makeError(message, code, detail) {
    const e = new Error(message || 'Unknown error');
    e.code = code || 'error';
    if (detail) e.detail = detail;
    return e;
  }

  /** UI text for the client's own errors (English when the dictionaries are not loaded in this context). */
  function t(key, fallback) {
    try {
      if (AYT.i18n && AYT.i18n.has(key)) return AYT.t(key);
    } catch (_) {
      /* ignore */
    }
    return fallback;
  }

  // Chrome's messages when no service worker answers (it is starting, crashed or was replaced).
  const NO_BACKGROUND_RE = /receiving end does not exist|could not establish connection|message port closed|message channel closed/i;
  const invalidatedError = () => makeError(t('toolbar.invalidated', 'The extension was updated. Refresh the page to keep using it.'), 'invalidated');
  const noBackgroundError = (code, detail) =>
    makeError(t('error.noBackground', "The extension's background service isn't responding. Try again in a moment."), code, detail);

  async function send(type, payload) {
    if (!contextValid()) {
      markInvalid();
      throw invalidatedError();
    }
    let res;
    try {
      res = await chrome.runtime.sendMessage(Object.assign({ type }, payload || {}));
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!contextValid() || /context invalidated/i.test(msg)) {
        markInvalid();
        throw invalidatedError();
      }
      if (NO_BACKGROUND_RE.test(msg)) throw noBackgroundError('runtime', msg);
      throw makeError(msg, 'runtime', msg);
    }
    if (!res) throw noBackgroundError('no_response');
    if (!res.ok) throw makeError(res.error, res.code);
    return res;
  }

  function wantPort() {
    return explicitRetains > 0 || autoRetained;
  }

  function connect() {
    if (port || invalidated) return;
    if (!contextValid()) {
      markInvalid();
      return;
    }
    stale = false;
    try {
      port = chrome.runtime.connect({ name: AYT.PORT_UI });
    } catch (e) {
      port = null;
      if (!contextValid()) markInvalid();
      else scheduleReconnect();
      return;
    }
    port.onMessage.addListener(onPush);
    port.onDisconnect.addListener(() => {
      void (chrome.runtime && chrome.runtime.lastError);
      port = null;
      if (!contextValid()) {
        markInvalid();
        return;
      }
      // Active jobs need their progress pushes: reconnect now. An open panel/popup alone does not justify
      // restarting the stopped worker every ~30 s; it reconnects (and gets a fresh snapshot) on activity.
      if (autoRetained) scheduleReconnect();
      else if (wantPort()) stale = true;
    });
  }

  /** Reopens a port that closed while idle, once the user interacts with the page again. */
  function resumeIfStale() {
    if (stale && !port && !invalidated && wantPort()) connect();
  }
  try {
    if (g.document && typeof g.addEventListener === 'function') {
      for (const ev of ['pointerdown', 'keydown', 'focusin']) g.addEventListener(ev, resumeIfStale, true);
      g.document.addEventListener('visibilitychange', () => {
        if (g.document.visibilityState === 'visible') resumeIfStale();
      });
    }
  } catch (_) {
    /* no DOM (service worker) */
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    stale = false;
    if (port) {
      try {
        port.disconnect();
      } catch (_) {
        /* ignore */
      }
      port = null;
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (wantPort()) connect();
    }, backoff);
    backoff = Math.min(backoff * 2, 8000);
  }

  function isActive(job) {
    return job && !AYT.JOB_DONE_STATES.includes(job.status);
  }

  function refreshAutoRetain() {
    const active = Array.from(jobs.values()).some(isActive);
    if (active !== autoRetained) {
      autoRetained = active;
      if (active) connect();
      else if (!wantPort()) disconnect();
    }
  }

  function jobList() {
    return Array.from(jobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function onPush(msg) {
    if (!msg || typeof msg !== 'object') return;
    backoff = 400;
    switch (msg.type) {
      case AYT.PUSH.JOBS:
        jobs.clear();
        for (const j of msg.jobs || []) jobs.set(j.id, j);
        emit('jobs', jobList());
        refreshAutoRetain();
        break;
      case AYT.PUSH.JOB:
        if (msg.job && msg.job.id) {
          jobs.set(msg.job.id, msg.job);
          emit('job', msg.job);
          emit('jobs', jobList());
          refreshAutoRetain();
        }
        break;
      case AYT.PUSH.JOB_REMOVED:
        jobs.delete(msg.jobId);
        emit('jobs', jobList());
        refreshAutoRetain();
        break;
      case AYT.PUSH.HOST:
        hostStatus = msg.status || null;
        emit('host', hostStatus);
        break;
      case AYT.PUSH.COMMAND:
        // viaKeyboard false: the popup's "open on the page" link was clicked with the mouse (keyboard shortcuts
        // and keyboard activations send nothing / true and keep the keyboard-open focus behaviour)
        emit('command', msg.command, msg.viaKeyboard === false ? { viaKeyboard: false } : undefined);
        break;
      default:
        break;
    }
  }

  // Commands / pushes sent to a tab with chrome.tabs.sendMessage (no port needed).
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.__aytPush === true) onPush(msg);
      return false;
    });
  } catch (_) {
    /* not available */
  }

  AYT.client = {
    send,
    contextValid,
    get invalidated() {
      return invalidated;
    },

    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },

    /** Hold the live update port open (call release() when the UI hides). */
    retain() {
      explicitRetains++;
      connect();
      return () => AYT.client.release();
    },

    release() {
      explicitRetains = Math.max(0, explicitRetains - 1);
      if (!wantPort()) disconnect();
    },

    /** Fetch a jobs snapshot once (without holding the port). */
    async syncJobs() {
      const res = await send(AYT.MSG.JOBS_LIST);
      jobs.clear();
      for (const j of res.jobs || []) jobs.set(j.id, j);
      emit('jobs', jobList());
      refreshAutoRetain();
      return jobList();
    },

    jobs: {
      list: jobList,
      get: (id) => jobs.get(id) || null,
      active: () => jobList().filter(isActive),
      isActive,
      async start(task, meta) {
        const res = await send(AYT.MSG.JOB_START, { task, meta });
        if (res.job) {
          jobs.set(res.job.id, res.job);
          emit('job', res.job);
          emit('jobs', jobList());
        }
        refreshAutoRetain();
        if (!port) connect();
        return res.jobId;
      },
      cancel: (jobId) => send(AYT.MSG.JOB_CANCEL, { jobId }),
      retry: (jobId) => send(AYT.MSG.JOB_RETRY, { jobId }).then((r) => {
        refreshAutoRetain();
        if (!port) connect();
        return r.jobId;
      }),
      remove: (jobId) => send(AYT.MSG.JOB_REMOVE, { jobId }),
      clear: () => send(AYT.MSG.JOBS_CLEAR),
      open: (jobId, target) => send(AYT.MSG.HOST_OPEN, { jobId, target: target || 'file' }),
    },

    host: {
      get status() {
        return hostStatus;
      },
      /** Ask the background for the companion status; refresh=true forces a new check. */
      async refresh(force) {
        const res = await send(AYT.MSG.HOST_STATUS, { refresh: !!force });
        hostStatus = res.status || null;
        emit('host', hostStatus);
        return hostStatus;
      },
      isReady() {
        return !!(hostStatus && hostStatus.state === 'connected');
      },
    },
  };
})(globalThis);
