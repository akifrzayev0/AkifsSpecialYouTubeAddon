/*
 * Akif's Special YouTube Addon — service-worker hub (owner: BACKGROUND).
 *
 *   AYT.bg.error(code, message)       Error with a machine-readable .code (router answers {ok:false, error, code})
 *   AYT.bg.addPort(port)              register an 'ayt-ui' port (snapshot is sent by the service worker)
 *   AYT.bg.broadcast(msg)             post a push message to every live UI port
 *   AYT.bg.isExtensionSender(sender)  message comes from one of our extension pages
 *   AYT.bg.isYouTubeSender(sender)    message comes from our content script on www.youtube.com
 *   AYT.bg.openOptions(section)       focus/open the options page at #section
 *   AYT.bg.openTab(url)               open chrome://extensions/shortcuts or one of our own pages
 *   AYT.bg.notify(id, opts)           chrome.notifications.create with our icon, never throws
 *
 * Loaded with importScripts() by background/service-worker.js. Classic script, no imports.
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  const t = (key, params) => AYT.t(key, params);

  /** Live UI ports (content scripts, popup, options). */
  const ports = new Set();

  /**
   * Creates an Error that the message router turns into { ok:false, error: message, code }.
   * @param {string} code machine-readable code (snake_case)
   * @param {string} [message] user-facing (already localized) text
   * @param {object} [extra] extra properties (e.g. { detail })
   */
  function error(code, message, extra) {
    const e = new Error(message || code);
    e.code = code || 'internal';
    if (extra) Object.assign(e, extra);
    return e;
  }

  /** Turns anything thrown by a handler into a router response. */
  function errorResponse(e) {
    if (e && typeof e === 'object' && typeof e.code === 'string' && e.message) {
      return { ok: false, error: String(e.message).slice(0, 2000), code: e.code };
    }
    const msg = String((e && e.message) || e || 'Unknown error').slice(0, 500);
    return { ok: false, error: t('error.generic', { message: msg }), code: 'internal' };
  }

  function addPort(port) {
    ports.add(port);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      ports.delete(port);
    });
  }

  function post(port, msg) {
    try {
      port.postMessage(msg);
      return true;
    } catch (_) {
      ports.delete(port);
      return false;
    }
  }

  /** Sends a push to every connected UI port. */
  function broadcast(msg) {
    for (const port of Array.from(ports)) post(port, msg);
  }

  function senderUrl(sender) {
    try {
      return new URL((sender && (sender.url || sender.origin)) || '');
    } catch (_) {
      return null;
    }
  }

  function isExtensionSender(sender) {
    const u = senderUrl(sender);
    return !!u && u.protocol === 'chrome-extension:' && u.hostname === chrome.runtime.id;
  }

  function isYouTubeSender(sender) {
    const u = senderUrl(sender);
    return !!u && u.protocol === 'https:' && u.hostname === 'www.youtube.com' && !!(sender && sender.tab);
  }

  function isEdge() {
    try {
      const brands = (g.navigator && g.navigator.userAgentData && g.navigator.userAgentData.brands) || [];
      if (brands.some((b) => /edge/i.test(b.brand))) return true;
      return /\bEdg\//.test((g.navigator && g.navigator.userAgent) || '');
    } catch (_) {
      return false;
    }
  }

  /**
   * Opens the options page at #section, re-using (and focusing) an already open options tab.
   * @param {string} [section] e.g. 'companion', 'downloads'
   */
  async function openOptions(section) {
    const base = chrome.runtime.getURL('options/options.html');
    const url = section ? base + '#' + section : base;
    let existing = null;
    try {
      if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
        existing = (contexts || []).find((c) => c.tabId >= 0 && typeof c.documentUrl === 'string' && c.documentUrl.startsWith(base)) || null;
      }
    } catch (_) {
      existing = null;
    }
    if (existing) {
      try {
        const props = { active: true };
        if (existing.documentUrl !== url) props.url = url;
        await chrome.tabs.update(existing.tabId, props);
        if (existing.windowId >= 0) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
        return;
      } catch (_) {
        /* the tab went away; open a new one */
      }
    }
    await chrome.tabs.create({ url });
  }

  /**
   * Opens a tab for an allow-listed URL: the browser's extension shortcuts page, this extension's details page,
   * or one of this extension's own pages. Anything else is refused.
   */
  async function openTab(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 2048) throw error('bad_url', t('background.err.badUrl'));
    let u;
    try {
      u = new URL(raw);
    } catch (_) {
      throw error('bad_url', t('background.err.badUrl'));
    }
    const scheme = isEdge() ? 'edge' : 'chrome';
    let url = null;
    if (u.protocol === 'chrome-extension:' && u.hostname === chrome.runtime.id && !u.username && !u.password) {
      url = u.href;
    } else if ((u.protocol === 'chrome:' || u.protocol === 'edge:') && u.hostname === 'extensions') {
      if (u.pathname === '/shortcuts' || u.pathname === '/configureCommands') url = scheme + '://extensions/shortcuts';
      else if ((u.pathname === '/' || u.pathname === '') && u.searchParams.get('id') === chrome.runtime.id) {
        url = scheme + '://extensions/?id=' + chrome.runtime.id;
      }
    }
    if (!url) throw error('bad_url', t('background.err.badUrl'));
    await chrome.tabs.create({ url });
  }

  /** chrome.notifications.create that never throws (notifications may be disabled by the OS). */
  async function notify(id, opts) {
    try {
      const o = Object.assign({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), priority: 0 }, opts);
      o.title = String(o.title || '').slice(0, 250);
      o.message = String(o.message || '').slice(0, 500);
      return await chrome.notifications.create(id, o);
    } catch (e) {
      console.warn('[AYT] notification failed', e && e.message);
      return null;
    }
  }

  function clearNotification(id) {
    try {
      const p = chrome.notifications.clear(id);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  /** Swallows the promise rejection of fire-and-forget chrome.* calls. */
  function quiet(p) {
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return p;
  }

  AYT.bg = {
    ports,
    error,
    errorResponse,
    addPort,
    post,
    broadcast,
    isExtensionSender,
    isYouTubeSender,
    isEdge,
    openOptions,
    openTab,
    notify,
    clearNotification,
    quiet,
  };
})(globalThis);
