/*
 * Akif's Special YouTube Addon — companion (native messaging host) manager (owner: BACKGROUND, spec §7.2 + §8).
 *
 *   AYT.native.status                    HostStatus { state, version?, protocol?, tools?, defaultDir?, downloadsDir?, error?, checkedAt }
 *   AYT.native.check(force) -> status    'hello' through the open port, else chrome.runtime.sendNativeMessage (cached 60 s)
 *   AYT.native.request(type, params, {timeout}) -> response   over the persistent connectNative port
 *   AYT.native.requestFriendly(...)      same, but errors carry user-facing (localized) messages
 *   AYT.native.onEvent(fn) / onDisconnect(fn(code, message)) / onStatus(fn(status))
 *   AYT.native.setBusyCheck(fn)          the port is closed 20 s after the last request when fn() is false
 *   AYT.native.pickFolder() / updateTools()
 *   AYT.native.statusCode(status)        job error code for a status that isn't 'connected' (host_missing, host_policy, ...)
 *
 * Protocol: requests { id, type, ...params } -> responses { re:id, ok:true, ... } | { re:id, ok:false, error, code? };
 * events { event, jobId, ... }. The host exits on stdin EOF, i.e. when we disconnect the port.
 * An updateTools request that timed out here still counts as in flight (no idle disconnect) until the host's late
 * answer arrives or the port closes: the host finishes an update it has started.
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  const t = (key, params) => AYT.t(key, params);
  const E = (code, message, extra) => AYT.bg.error(code, message, extra);

  const HOST_IDENT = 'akif-youtube-addon-host';
  const STATES = ['unknown', 'checking', 'connected', 'missing', 'forbidden', 'error', 'outdated'];

  /** Tunables (tests shorten them). */
  const config = {
    checkTtlMs: 60 * 1000,
    helloTimeoutMs: 25 * 1000,
    requestTimeoutMs: 15 * 1000,
    idleDisconnectMs: 20 * 1000,
    // updateTools: the companion gives up after 9 min (code update_timeout, UPDATE_BUDGET_MS in companion/host/host.ts),
    // so it always answers first; the options page waits 20 s longer than this (AYT.pages.TIMEOUTS.updateTools).
    timeouts: { pickFolder: 5 * 60 * 1000, updateTools: 10 * 60 * 1000, hello: 25 * 1000 },
    /** How long a timed-out request of LATE_TYPES still keeps the port open while the host may answer it late. */
    lateAnswerMs: 10 * 60 * 1000,
  };

  /** Requests the host keeps working on after our timeout (it finishes an update even after stdin EOF). */
  const LATE_TYPES = ['updateTools'];

  /** Transport seam: Chrome's native messaging by default; tests may swap it (setTransport). */
  const chromeTransport = {
    connect: (name) => chrome.runtime.connectNative(name),
    sendOnce: (name, msg) => chrome.runtime.sendNativeMessage(name, msg),
    lastError: () => {
      const le = chrome.runtime.lastError;
      return le ? le.message || String(le) : '';
    },
  };
  let transport = chromeTransport;

  let status = { state: 'unknown', checkedAt: 0 };
  let statusErrorKey = null; // i18n key of status.error (re-localized on language change)
  let checking = null;
  let port = null;
  let portHealthy = false;
  let seq = 0;
  const pending = new Map(); // id -> { resolve, reject, timer, type }
  const late = new Map(); // id -> { type, timer }: timed out here, but the host is still working on it
  let idleTimer = 0;
  let busyCheck = () => false;
  const eventListeners = new Set();
  const disconnectListeners = new Set();
  const statusListeners = new Set();

  function nextId() {
    seq = (seq + 1) % 1e9;
    return Date.now().toString(36) + '-' + seq.toString(36);
  }

  function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && isFinite(v) ? String(v) : undefined;
  }

  /**
   * Maps Chrome's native-messaging error strings (native_message_host.cc / message_service.cc) to a kind:
   * 'policy' = "Access to the native messaging host was disabled by the system administrator." (the
   * NativeMessagingBlocklist / NativeMessagingUserLevelHosts policies); 'forbidden' = the host's allowed_origins
   * do not list this extension.
   * @returns {'missing'|'policy'|'forbidden'|'error'}
   */
  function classify(message) {
    const m = String(message || '');
    if (/host not found/i.test(m)) return 'missing';
    if (/disabled by the system administrator/i.test(m)) return 'policy';
    if (/forbidden|requires nativeMessaging permission/i.test(m)) return 'forbidden';
    return 'error';
  }

  /** Error code for a classify() kind. */
  function kindCode(kind) {
    if (kind === 'missing') return 'host_missing';
    if (kind === 'policy') return 'host_policy';
    if (kind === 'forbidden') return 'host_forbidden';
    return 'host_error';
  }

  /** HostStatus for a 'policy' / 'forbidden' kind (both are the 'forbidden' state, with their own text). */
  function blockedStatus(kind, message) {
    const detail = String(message || '').slice(0, 300);
    if (kind === 'policy') return { state: 'forbidden', reason: 'policy', errorKey: 'background.host.policy', detail };
    return { state: 'forbidden', errorKey: 'background.host.forbidden', detail };
  }

  /** Job error code for a status that isn't 'connected' (jobs fail with it when the companion can't be used). */
  function statusCode(st) {
    const s = st || {};
    if (s.state === 'missing') return 'host_missing';
    if (s.state === 'forbidden') return s.reason === 'policy' ? 'host_policy' : 'host_forbidden';
    if (s.state === 'outdated') return 'host_outdated';
    return 'host_error';
  }

  /* ------------------------------------------------------------------ status */

  function cleanTools(tools) {
    if (!tools || typeof tools !== 'object') return undefined;
    const out = {};
    for (const name of ['ytdlp', 'ffmpeg', 'deno']) {
      const src = tools[name];
      if (!src || typeof src !== 'object') continue;
      const tool = {};
      for (const [k, v] of Object.entries(src).slice(0, 12)) {
        const s = str(v, k === 'path' ? 1024 : 200);
        if (s !== undefined) tool[k] = s;
        else if (typeof v === 'boolean') tool[k] = v;
      }
      out[name] = tool;
    }
    return out;
  }

  function statusFromHello(res) {
    if (!res || typeof res !== 'object' || (res.name !== undefined && res.name !== HOST_IDENT)) {
      return { state: 'error', errorKey: 'background.host.badAnswer' };
    }
    const protocol = Number(res.protocol) || 0;
    const s = {
      state: protocol < AYT.PROTOCOL_VERSION ? 'outdated' : 'connected',
      version: str(res.version, 40),
      protocol,
      platform: str(res.platform, 40),
      tools: cleanTools(res.tools),
      defaultDir: str(res.defaultDir, 1024),
      downloadsDir: str(res.downloadsDir, 1024),
    };
    if (s.state === 'outdated') s.errorKey = 'host.outdated.text';
    return s;
  }

  function statusFromError(e) {
    const code = e && e.code;
    const message = String((e && (e.detail || e.message)) || '');
    if (code === 'timeout') return { state: 'error', errorKey: 'background.host.timeout' };
    if (code === 'host_answer') return { state: 'error', errorKey: 'background.host.badAnswer', detail: message.slice(0, 300) };
    const kind = classify(message);
    if (kind === 'missing') return { state: 'missing' };
    if (kind === 'policy' || kind === 'forbidden') return blockedStatus(kind, message);
    return { state: 'error', errorKey: 'background.host.startFailed', detail: message.slice(0, 300) };
  }

  function comparable(s) {
    return JSON.stringify(Object.assign({}, s, { checkedAt: 0 }));
  }

  function setStatus(next) {
    const errorKey = next.errorKey || null;
    const s = Object.assign({}, next);
    delete s.errorKey;
    if (errorKey) s.error = t(errorKey);
    else delete s.error;
    for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k];
    if (!s.checkedAt) s.checkedAt = Date.now();
    const changed = comparable(s) !== comparable(status);
    status = s;
    statusErrorKey = errorKey;
    if (changed) {
      // Only real changes are stored: every chrome.storage write reaches every YouTube tab's storage listener, and the
      // stored copy is only a first-paint hint (a stale checkedAt just makes the next check() ask the host again).
      AYT.bg.quiet(chrome.storage.local.set({ [AYT.STORAGE.HOST_STATUS]: s }));
      AYT.bg.broadcast({ type: AYT.PUSH.HOST, status: s });
      statusListeners.forEach((fn) => {
        try {
          fn(s);
        } catch (err) {
          console.error('[AYT] status listener', err);
        }
      });
    }
    return s;
  }

  /** Mark the cached status stale (next check() asks the host again). */
  function invalidate() {
    status = Object.assign({}, status, { checkedAt: 0 });
  }

  function withTimeout(promise, ms, code) {
    let timer = 0;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(E(code || 'timeout', t('background.host.timeout'))), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** Lets the host compute defaultDir = <Downloads>\<subfolder> exactly like the extension does. */
  function helloParams() {
    let subfolder = '';
    try {
      subfolder = String(AYT.settings.get('subfolder') || '');
    } catch (_) {
      /* settings not loaded yet: the host uses its default */
    }
    return subfolder ? { subfolder } : {};
  }

  async function helloOnce() {
    let res;
    try {
      const p = Promise.resolve().then(() => transport.sendOnce(AYT.HOST_NAME, Object.assign({ id: nextId(), type: 'hello' }, helloParams())));
      p.catch(() => {}); // a late rejection after the timeout must not become an unhandled rejection
      res = await withTimeout(p, config.helloTimeoutMs, 'timeout');
    } catch (e) {
      if (e && e.code) throw e;
      throw E('host_error', String((e && e.message) || e), { detail: String((e && e.message) || e) });
    }
    if (!res || typeof res !== 'object') throw E('host_answer', 'empty answer');
    if (res.ok === false) throw E('host_answer', String(res.error || 'hello failed'));
    return res;
  }

  /**
   * Returns the companion status, asking the host when forced or when the cached result is older than 60 s.
   * Concurrent calls share one check.
   * @param {boolean} force
   */
  function check(force) {
    if (checking) return checking;
    const fresh = status.state !== 'unknown' && status.state !== 'checking' && Date.now() - (status.checkedAt || 0) < config.checkTtlMs;
    if (!force && fresh) return Promise.resolve(status);
    checking = (async () => {
      let next;
      try {
        const res = port ? await request('hello', helloParams(), { timeout: config.helloTimeoutMs }) : await helloOnce();
        next = statusFromHello(res);
      } catch (e) {
        next = statusFromError(e);
      }
      next.checkedAt = Date.now();
      return setStatus(next);
    })().finally(() => {
      checking = null;
    });
    return checking;
  }

  /* ------------------------------------------------------------------ persistent port */

  function onPortMessage(p, msg) {
    if (p !== port || !msg || typeof msg !== 'object') return;
    portHealthy = true;
    if (msg.re !== undefined && msg.re !== null) {
      const id = String(msg.re);
      const req = pending.get(id);
      if (!req) {
        // The late answer of a request that timed out here: it no longer keeps the port open.
        const lateReq = takeLate(id);
        if (lateReq) {
          if (lateReq.type === 'updateTools') check(true).catch(() => {}); // the tool versions may have changed
          scheduleIdle();
        }
        return;
      }
      pending.delete(id);
      clearTimeout(req.timer);
      if (msg.ok === false) {
        req.reject(E(typeof msg.code === 'string' && msg.code ? msg.code.slice(0, 40) : 'host_failed', String(msg.error || 'Companion error').slice(0, 2000), { fromHost: true }));
      } else req.resolve(msg);
      scheduleIdle();
      return;
    }
    if (typeof msg.event === 'string') {
      eventListeners.forEach((fn) => {
        try {
          fn(msg);
        } catch (err) {
          console.error('[AYT] host event listener', err);
        }
      });
    }
  }

  function onPortDisconnect(p) {
    const message = transport.lastError() || '';
    if (p !== port) return;
    port = null;
    clearTimeout(idleTimer);
    const healthy = portHealthy;
    portHealthy = false;
    const kind = message ? classify(message) : 'error';
    const code = kind === 'error' ? (healthy ? 'host_exit' : 'host_error') : kindCode(kind);
    for (const [, req] of pending) {
      clearTimeout(req.timer);
      req.reject(E(code, message || code, { detail: message }));
    }
    pending.clear();
    clearLate();
    if (kind === 'missing') setStatus({ state: 'missing' });
    else if (kind === 'policy' || kind === 'forbidden') setStatus(blockedStatus(kind, message));
    else if (!healthy) setStatus({ state: 'error', errorKey: 'background.host.startFailed', detail: message.slice(0, 300) });
    else {
      // The host was working and went away (crash / killed): ask a fresh host process shortly.
      invalidate();
      setTimeout(() => check(true).catch(() => {}), 1500);
    }
    disconnectListeners.forEach((fn) => {
      try {
        fn(code, message);
      } catch (err) {
        console.error('[AYT] host disconnect listener', err);
      }
    });
  }

  function ensurePort() {
    if (port) return port;
    let p;
    try {
      p = transport.connect(AYT.HOST_NAME);
    } catch (e) {
      const message = String((e && e.message) || e);
      throw E(kindCode(classify(message)), message, { detail: message });
    }
    port = p;
    portHealthy = false;
    p.onMessage.addListener((msg) => onPortMessage(p, msg));
    p.onDisconnect.addListener(() => onPortDisconnect(p));
    return p;
  }

  /**
   * Sends a request over the persistent port and resolves with the host's response (rejects on ok:false,
   * disconnect or timeout). Errors carry .code (host_missing, host_exit, timeout, or the host's code).
   * @param {string} type
   * @param {object} [params]
   * @param {{timeout?: number}} [opts]
   */
  function request(type, params, opts) {
    const timeout = (opts && opts.timeout) || config.timeouts[type] || config.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let p;
      try {
        p = ensurePort();
      } catch (e) {
        reject(e);
        return;
      }
      const id = nextId();
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          if (LATE_TYPES.includes(type) && port === p) keepLate(id, type);
          reject(E('timeout', t('background.host.timeout')));
          scheduleIdle();
        }
      }, timeout);
      pending.set(id, { resolve, reject, timer, type });
      clearTimeout(idleTimer);
      try {
        p.postMessage(Object.assign({}, params || {}, { id, type }));
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        const message = String((e && e.message) || e);
        reject(E('host_exit', message, { detail: message }));
      }
    });
  }

  /**
   * Friendly (localized) text for an error from request(): connection problems map to job.err.<code>; an error
   * answered by the host uses fallbackKey when given (e.g. 'Couldn't open the file'), else the host's own message.
   */
  function describeError(e, fallbackKey) {
    const code = (e && e.code) || 'unknown';
    // literal keys (the i18n checker looks for them): connection problems and our own timeout
    switch (code) {
      case 'host_missing': return t('job.err.host_missing');
      case 'host_forbidden': return t('job.err.host_forbidden');
      case 'host_policy': return t('job.err.host_policy');
      case 'host_error': return t('job.err.host_error');
      case 'host_exit': return t('job.err.host_exit');
      case 'host_outdated': return t('job.err.host_outdated');
      case 'timeout': return t('job.err.timeout');
      default: break;
    }
    if (fallbackKey) return t(fallbackKey);
    if (e && e.fromHost && e.message) return e.message;
    return t('error.generic', { message: String((e && e.message) || e) });
  }

  /** request() whose errors have user-facing messages (for router handlers). */
  async function requestFriendly(type, params, opts, fallbackKey) {
    try {
      return await request(type, params, opts);
    } catch (e) {
      throw E((e && e.code) || 'host_failed', describeError(e, fallbackKey), { detail: e && (e.detail || e.message) });
    }
  }

  /** Remembers a timed-out request the host is still working on (see LATE_TYPES), for at most config.lateAnswerMs. */
  function keepLate(id, type) {
    const timer = setTimeout(() => {
      if (late.delete(id)) scheduleIdle();
    }, config.lateAnswerMs);
    late.set(id, { type, timer });
  }

  /** Removes and returns the late entry of a request id (null when there is none). */
  function takeLate(id) {
    const entry = late.get(id);
    if (!entry) return null;
    clearTimeout(entry.timer);
    late.delete(id);
    return entry;
  }

  function clearLate() {
    for (const entry of late.values()) clearTimeout(entry.timer);
    late.clear();
  }

  /** Requests still in flight at the host: waiting for an answer, or timed out here but still running there. */
  function inFlight() {
    return pending.size + late.size;
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    if (!port || inFlight() || busy()) return;
    idleTimer = setTimeout(() => {
      idleTimer = 0;
      if (port && !inFlight() && !busy()) disconnect();
    }, config.idleDisconnectMs);
  }

  function busy() {
    try {
      return !!busyCheck();
    } catch (_) {
      return false;
    }
  }

  /** Closes the port (the host sees stdin EOF and exits). Pending requests are rejected. */
  function disconnect() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    const p = port;
    port = null;
    portHealthy = false;
    if (!p) return;
    for (const [, req] of pending) {
      clearTimeout(req.timer);
      req.reject(E('host_exit', 'disconnected'));
    }
    pending.clear();
    clearLate();
    try {
      p.disconnect();
    } catch (_) {
      /* already gone */
    }
  }

  /* ------------------------------------------------------------------ host actions for the router */

  /** Localized text + the host's first reason line (in English, but it names the cause, e.g. an execution policy). */
  function withReason(text, e) {
    const reason = String((e && e.message) || '').split(/\r?\n/)[0].trim().slice(0, 200);
    return reason ? text + ' — ' + reason : text;
  }

  async function pickFolder() {
    const initial = (AYT.settings.get('outputDir') || status.defaultDir || '').slice(0, 1024);
    const params = { title: t('background.pickFolderTitle') };
    if (initial) params.initial = initial;
    let res;
    try {
      res = await request('pickFolder', params, { timeout: config.timeouts.pickFolder });
    } catch (e) {
      // picker_failed & co.: the dialog could not be shown; connection problems keep their usual texts
      const text = e && e.fromHost ? withReason(t('background.err.pickFailed'), e) : describeError(e);
      throw E((e && e.code) || 'host_failed', text, { detail: e && (e.detail || e.message) });
    }
    return { path: typeof res.path === 'string' && res.path ? res.path.slice(0, 1024) : null };
  }

  function versionOf(v) {
    if (typeof v === 'string') return v.slice(0, 200);
    if (v && typeof v === 'object') {
      const inner = v.ytdlp && typeof v.ytdlp === 'object' ? v.ytdlp.version : v.version;
      return typeof inner === 'string' ? inner.slice(0, 200) : '';
    }
    return '';
  }

  /**
   * Localized text for a failed updateTools. The host answers with code busy | unsupported | ytdlp_missing |
   * network | update_timeout (its own 9-minute limit: it did answer, so not job.err.timeout) | update_failed;
   * no answer at all (host gone, our timeout) is described like any request error.
   */
  function updateErrorText(e) {
    if (!e || !e.fromHost) return describeError(e);
    switch (e.code) {
      case 'busy': return t('background.err.updateBusy');
      case 'unsupported': return t('background.err.updateUnsupported');
      case 'ytdlp_missing': return t('job.err.ytdlp_missing');
      case 'network': return t('background.err.updateNetwork');
      case 'update_timeout': return t('background.err.updateTimeout');
      default:
        // update_failed (or an unknown code): the host's reason helps (access denied, checksum mismatch, exit code)
        return /^update failed\.?$/i.test(String(e.message || '').trim()) ? t('background.err.updateFailed') : withReason(t('background.err.updateFailed'), e);
    }
  }

  async function updateTools() {
    let res;
    try {
      res = await request('updateTools', {}, { timeout: config.timeouts.updateTools });
    } catch (e) {
      throw E((e && e.code) || 'host_failed', updateErrorText(e), { detail: e && (e.detail || e.message) });
    }
    check(true).catch(() => {}); // refresh tool versions shown in the options page
    const output = typeof res.output === 'string' ? res.output.slice(-20000) : '';
    const after = versionOf(res.after);
    return { output, version: after, before: versionOf(res.before), after };
  }

  /* ------------------------------------------------------------------ lifecycle */

  async function init() {
    try {
      const stored = (await chrome.storage.local.get(AYT.STORAGE.HOST_STATUS))[AYT.STORAGE.HOST_STATUS];
      if (stored && typeof stored === 'object' && STATES.includes(stored.state) && stored.state !== 'checking' && status.state === 'unknown') {
        status = Object.assign({}, stored);
      }
    } catch (e) {
      console.warn('[AYT] host status load failed', e);
    }
  }

  /** Re-translate status.error after a language change. */
  function relocalize() {
    if (statusErrorKey && status.error) {
      status = Object.assign({}, status, { error: t(statusErrorKey) });
      AYT.bg.broadcast({ type: AYT.PUSH.HOST, status });
    }
  }

  AYT.native = {
    config,
    get status() {
      return status;
    },
    get connected() {
      return !!port;
    },
    get pendingCount() {
      return pending.size;
    },
    /** timed-out requests the host may still answer (they keep the port open) */
    get lateCount() {
      return late.size;
    },
    init,
    check,
    invalidate,
    request,
    requestFriendly,
    describeError,
    disconnect,
    scheduleIdle,
    pickFolder,
    updateTools,
    relocalize,
    classify,
    statusCode,
    statusFromHello,
    statusFromError,
    setBusyCheck(fn) {
      busyCheck = typeof fn === 'function' ? fn : () => false;
    },
    onEvent(fn) {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    onDisconnect(fn) {
      disconnectListeners.add(fn);
      return () => disconnectListeners.delete(fn);
    },
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    /** Test seam: replace Chrome's native messaging ({connect, sendOnce, lastError}); null restores it. */
    setTransport(tr) {
      disconnect();
      transport = tr ? Object.assign({}, chromeTransport, tr) : chromeTransport;
      status = { state: 'unknown', checkedAt: 0 };
      statusErrorKey = null;
    },
  };
})(globalThis);
