/*
 * Akif's Special YouTube Addon — MAIN-world bridge server.
 * Runs in the page's JavaScript world (manifest content_scripts "world": "MAIN") at document_start.
 *
 * Talks to the isolated content scripts through window.postMessage:
 *   isolated -> main : { __ayt:'AYT_BRIDGE_V1', dir:'i2m', id, method, params }
 *   main -> isolated : { __ayt:'AYT_BRIDGE_V1', dir:'m2i', re:id, ok, result | error, code }
 *   main -> isolated : { __ayt:'AYT_BRIDGE_V1', dir:'m2i', event, payload }   (events: ready, urlchange, videochange, captions)
 *
 * It only reads data from YouTube's own player and never executes anything it receives.
 * YouTube enforces Trusted Types in this world: no innerHTML / DOMParser / eval here.
 */
(function () {
  'use strict';
  if (window.__aytMainWorld) return;
  window.__aytMainWorld = { version: 2 };

  const BRIDGE = 'AYT_BRIDGE_V1';
  const ORIGIN = location.origin;
  // Captured at document_start, before our own hook below and before any page script.
  const nativeFetch = typeof window.fetch === 'function' ? window.fetch : null;

  function post(msg) {
    const base = { __ayt: BRIDGE, dir: 'm2i' };
    try {
      window.postMessage(Object.assign(base, msg), ORIGIN);
    } catch (_) {
      window.postMessage(Object.assign(base, JSON.parse(JSON.stringify(msg))), ORIGIN);
    }
  }
  const emit = (event, payload) => post({ event, payload: payload || null });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ navigation */
  // Shorts swipes and some SPA navigations go through the Navigation API (no history.pushState calls).
  try {
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigatesuccess', () => emit('urlchange', { url: location.href }));
    }
  } catch (_) {
    /* ignore */
  }

  /* ------------------------------------------------------------------ player lookup */
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function players() {
    const list = [];
    const main = document.getElementById('movie_player');
    if (main) list.push(main);
    document.querySelectorAll('#shorts-player, ytd-shorts .html5-video-player').forEach((p) => {
      if (!list.includes(p)) list.push(p);
    });
    return list.filter((p) => typeof p.getPlayerResponse === 'function' || typeof p.getVideoData === 'function');
  }

  function videoIdOf(p) {
    try {
      const d = p.getVideoData && p.getVideoData();
      if (d && d.video_id) return d.video_id;
    } catch (_) {
      /* ignore */
    }
    try {
      const r = p.getPlayerResponse && p.getPlayerResponse();
      if (r && r.videoDetails) return r.videoDetails.videoId;
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function onShorts(surface) {
    return surface === 'shorts' || location.pathname.startsWith('/shorts/');
  }

  /** Player showing `videoId` (or the most relevant player for the surface when no id is given). */
  function findPlayer(videoId, surface) {
    const all = players();
    if (videoId) {
      const matching = all.filter((p) => videoIdOf(p) === videoId);
      return matching.find(isVisible) || matching[0] || null;
    }
    if (onShorts(surface)) {
      const shorts = all.filter((p) => p.id !== 'movie_player');
      return shorts.find(isVisible) || shorts[0] || null;
    }
    return document.getElementById('movie_player') || all[0] || null;
  }

  async function waitForPlayer(videoId, surface, timeoutMs) {
    const end = Date.now() + (timeoutMs || 4000);
    for (;;) {
      const p = findPlayer(videoId, surface);
      if (p) return p;
      if (Date.now() > end) return null;
      await sleep(150);
    }
  }

  function videoEl(p) {
    return (p && p.querySelector('video')) || null;
  }

  function safeCall(p, fn, ...args) {
    try {
      return p && typeof p[fn] === 'function' ? p[fn](...args) : undefined;
    } catch (_) {
      return undefined;
    }
  }

  /* ------------------------------------------------------------------ player response (pruned) */
  function textOf(x) {
    if (!x) return '';
    if (typeof x === 'string') return x;
    if (x.simpleText) return x.simpleText;
    if (Array.isArray(x.runs)) return x.runs.map((r) => r.text || '').join('');
    return '';
  }

  const FORMAT_KEYS = ['itag', 'mimeType', 'bitrate', 'averageBitrate', 'width', 'height', 'fps', 'quality', 'qualityLabel', 'contentLength', 'approxDurationMs', 'colorInfo', 'audioTrack', 'audioQuality', 'audioSampleRate', 'audioChannels', 'isDrc', 'xtags', 'projectionType', 'drmFamilies', 'type'];

  function pruneFormat(f) {
    const o = {};
    for (const k of FORMAT_KEYS) if (f[k] !== undefined) o[k] = f[k];
    o.hasUrl = !!(f.url || f.signatureCipher || f.cipher);
    return o;
  }

  function pruneResponse(r) {
    if (!r || !r.videoDetails) return null;
    const vd = r.videoDetails;
    const mf = (r.microformat && r.microformat.playerMicroformatRenderer) || {};
    const sd = r.streamingData || {};
    const ps = r.playabilityStatus || {};
    const ctr = (r.captions && r.captions.playerCaptionsTracklistRenderer) || {};
    const reason =
      ps.reason ||
      textOf(ps.errorScreen && ps.errorScreen.playerErrorMessageRenderer && ps.errorScreen.playerErrorMessageRenderer.reason) ||
      '';
    return {
      videoDetails: {
        videoId: vd.videoId,
        title: vd.title,
        author: vd.author,
        channelId: vd.channelId,
        lengthSeconds: vd.lengthSeconds,
        isLive: !!vd.isLive,
        isLiveContent: !!vd.isLiveContent,
        isUpcoming: !!vd.isUpcoming,
        isPrivate: !!vd.isPrivate,
        thumbnails: (vd.thumbnail && vd.thumbnail.thumbnails) || [],
      },
      microformat: {
        publishDate: mf.publishDate || null,
        uploadDate: mf.uploadDate || null,
        category: mf.category || null,
        isShortsEligible: mf.isShortsEligible,
        liveBroadcastDetails: mf.liveBroadcastDetails || null,
        thumbnails: (mf.thumbnail && mf.thumbnail.thumbnails) || [],
      },
      playabilityStatus: { status: ps.status || 'OK', reason },
      streamingData: {
        formats: (sd.formats || []).map(pruneFormat),
        adaptiveFormats: (sd.adaptiveFormats || []).map(pruneFormat),
        drmFamilies: sd.drmFamilies || null,
        hasHls: !!sd.hlsManifestUrl,
        hasSabr: !!sd.serverAbrStreamingUrl,
        expiresInSeconds: sd.expiresInSeconds || null,
      },
      captions: {
        tracks: (ctr.captionTracks || []).map((t) => ({
          baseUrl: t.baseUrl,
          languageCode: t.languageCode,
          name: textOf(t.name),
          kind: t.kind || '',
          vssId: t.vssId || '',
          isTranslatable: !!t.isTranslatable,
        })),
        translationLanguages: (ctr.translationLanguages || []).map((l) => ({ languageCode: l.languageCode, name: textOf(l.languageName) })),
      },
    };
  }

  function initialResponseFor(videoId) {
    // ytInitialPlayerResponse is only correct for the very first video of a page load.
    const r = window.ytInitialPlayerResponse;
    return r && r.videoDetails && r.videoDetails.videoId === videoId ? r : null;
  }

  function rawResponse(videoId, surface) {
    const p = findPlayer(videoId, surface);
    const r = safeCall(p, 'getPlayerResponse');
    if (r && r.videoDetails && (!videoId || r.videoDetails.videoId === videoId)) return r;
    return videoId ? initialResponseFor(videoId) : null;
  }

  async function getPlayerResponse(params) {
    const videoId = params.videoId || null;
    const end = Date.now() + (params.timeoutMs || 5000);
    // Right after SPA navigation the player may still be switching: wait a little.
    for (;;) {
      const r = rawResponse(videoId, params.surface);
      if (r) return pruneResponse(r);
      if (Date.now() > end) return null;
      await sleep(200);
    }
  }

  /* ------------------------------------------------------------------ captions (PO token recipe)
   * Verified Nov 2026: captionTracks[].baseUrl carries exp=xpe; without the player's PO token ("pot")
   * /api/timedtext answers 200 with an EMPTY body for every fmt. The player's own XHR adds
   * &pot=..&potc=1&c=WEB&cver=..; baseUrl + &pot + &c=WEB [+ &cver] + &fmt works for vtt, srv1, srv2,
   * srv3, ttml, json3 and with &tlang=<lang>. The pot is bound to the video id (not the language).
   */
  const potByVideo = new Map(); // videoId -> { pot, c, cver, at }   (insertion order = least recently seen first)
  const capCache = new Map(); // `${v}|${lang}|${kind}|${tlang}|${fmt}` -> { body, at }   (least recently used first)
  const potWaiters = new Set();
  const POT_TTL_MS = 4 * 60 * 60 * 1000;
  const POT_MAX = 50; // videos
  const CAP_KEEP_MS = 30 * 60 * 1000; // unused bodies are dropped after this
  const CAP_MAX_ENTRIES = 6;
  const CAP_MAX_CHARS = 4 * 1024 * 1024; // all cached caption bodies together (UTF-16 code units)
  let capChars = 0;
  let capTimer = 0;

  function notePot(v, rec) {
    potByVideo.delete(v);
    potByVideo.set(v, rec);
    while (potByVideo.size > POT_MAX) potByVideo.delete(potByVideo.keys().next().value);
  }

  function capDelete(key) {
    const e = capCache.get(key);
    if (!e) return;
    capChars -= e.body.length;
    capCache.delete(key);
  }

  /** Drops expired bodies, then the least recently used ones over the limits; re-arms the expiry timer. */
  function pruneCaptions() {
    const now = Date.now();
    for (const [k, e] of Array.from(capCache)) if (now - e.at > CAP_KEEP_MS) capDelete(k);
    while (capCache.size && (capCache.size > CAP_MAX_ENTRIES || capChars > CAP_MAX_CHARS)) capDelete(capCache.keys().next().value);
    if (!capCache.size) capChars = 0;
    clearTimeout(capTimer);
    capTimer = 0;
    if (capCache.size) {
      const oldest = capCache.values().next().value.at;
      capTimer = setTimeout(pruneCaptions, Math.max(1000, oldest + CAP_KEEP_MS - now + 1000));
    }
  }

  function capGet(key) {
    const e = capCache.get(key);
    if (!e) return null;
    if (Date.now() - e.at > CAP_KEEP_MS) {
      capDelete(key);
      return null;
    }
    capCache.delete(key); // most recently used goes last
    e.at = Date.now();
    capCache.set(key, e);
    return e.body;
  }

  function capPut(key, body) {
    capDelete(key);
    if (body.length > CAP_MAX_CHARS) return;
    capCache.set(key, { body, at: Date.now() });
    capChars += body.length;
    pruneCaptions();
  }

  function noteTimedtext(url, body) {
    let u;
    try {
      u = new URL(url, location.origin);
    } catch (_) {
      return;
    }
    if (u.pathname.indexOf('/api/timedtext') === -1) return;
    const q = u.searchParams;
    const v = q.get('v');
    if (!v) return;
    const now = Date.now();
    const pot = q.get('pot');
    if (pot) {
      notePot(v, { pot, c: q.get('c') || 'WEB', cver: q.get('cver') || '', at: now });
      potWaiters.forEach((w) => w(v));
    }
    if (body && body.length > 2) {
      const key = [v, q.get('lang') || '', q.get('kind') || '', q.get('tlang') || '', q.get('fmt') || 'srv1'].join('|');
      capPut(key, body);
      emit('captions', { videoId: v, lang: q.get('lang'), kind: q.get('kind') || '', tlang: q.get('tlang') || '', fmt: q.get('fmt') || 'srv1' });
    }
  }

  function bodyFromXhr(xhr) {
    try {
      if (xhr.responseType === '' || xhr.responseType === 'text') return xhr.responseText || '';
      if (xhr.responseType === 'json') return xhr.response ? JSON.stringify(xhr.response) : '';
      if (xhr.responseType === 'arraybuffer' && xhr.response) return new TextDecoder().decode(xhr.response);
    } catch (_) {
      /* ignore */
    }
    return '';
  }

  // 1) XHR hook (the player uses XHR for /api/timedtext) — catches URL + body.
  try {
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSend = XHR.send;
    XHR.open = function (method, url) {
      try {
        this.__aytUrl = String(url);
      } catch (_) {
        /* ignore */
      }
      return origOpen.apply(this, arguments);
    };
    XHR.send = function () {
      try {
        if (this.__aytUrl && this.__aytUrl.indexOf('/api/timedtext') !== -1) {
          noteTimedtext(this.__aytUrl, '');
          this.addEventListener('load', () => noteTimedtext(this.responseURL || this.__aytUrl, bodyFromXhr(this)));
        }
      } catch (_) {
        /* ignore */
      }
      return origSend.apply(this, arguments);
    };
  } catch (_) {
    /* ignore */
  }

  // 2) fetch hook (in case the player switches transport).
  try {
    const origFetch = window.fetch;
    window.fetch = function (input) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
        if (url && url.indexOf('/api/timedtext') !== -1) {
          noteTimedtext(url, '');
          p.then((res) => res.clone().text().then((body) => noteTimedtext(res.url || url, body))).catch(() => {});
        }
      } catch (_) {
        /* ignore */
      }
      return p;
    };
  } catch (_) {
    /* ignore */
  }

  // 3) Resource timing observer (buffered; YouTube calls clearResourceTimings, so don't poll).
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name && e.name.indexOf('/api/timedtext') !== -1) noteTimedtext(e.name, '');
    }).observe({ type: 'resource', buffered: true });
  } catch (_) {
    /* ignore */
  }

  function freshPot(videoId) {
    const p = potByVideo.get(videoId);
    if (p && Date.now() - p.at < POT_TTL_MS) return p;
    if (p) potByVideo.delete(videoId);
    return null;
  }

  /** The player shows an ad (pre-roll, mid-roll or the switch to one): its caption requests are for the ad. */
  function adShowing(player) {
    return !!(player && player.classList && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')));
  }
  const adError = () => Object.assign(new Error('An ad is playing. Try again when the video continues.'), { code: 'ad' });

  function waitForPot(videoId, timeoutMs) {
    return new Promise((resolve) => {
      const hit = freshPot(videoId);
      if (hit) return resolve(hit);
      const done = (v) => {
        clearTimeout(timer);
        potWaiters.delete(waiter);
        resolve(v);
      };
      const waiter = (vid) => {
        if (vid === videoId) done(freshPot(videoId));
      };
      const timer = setTimeout(() => done(freshPot(videoId)), timeoutMs);
      potWaiters.add(waiter);
    });
  }

  const STICKY_KEYS = ['yt-player-caption-sticky-language', 'yt-player-caption-persistence'];

  /** Makes the player request captions (hidden), so it mints/uses a PO token for this video; restores everything. */
  async function triggerPot(player, videoId, languageCode) {
    const savedLs = {};
    for (const k of STICKY_KEYS) {
      try {
        savedLs[k] = localStorage.getItem(k);
      } catch (_) {
        /* ignore */
      }
    }
    const prevTrack = safeCall(player, 'getOption', 'captions', 'track');
    const wasOn = !!(safeCall(player, 'isSubtitlesOn') || (prevTrack && prevTrack.languageCode));
    const hide = document.createElement('style');
    hide.textContent = '.ytp-caption-window-container{visibility:hidden!important}';
    (document.head || document.documentElement).appendChild(hide);
    try {
      safeCall(player, 'loadModule', 'captions');
      for (let attempt = 0; attempt < 5; attempt++) {
        // A (mid-roll) ad that starts now would get the caption request (and the token) for the ad's video.
        if (adShowing(player)) throw adError();
        safeCall(player, 'setOption', 'captions', 'track', { languageCode });
        const pot = await waitForPot(videoId, 4000);
        if (pot) return pot;
        safeCall(player, 'setOption', 'captions', 'track', {});
        await sleep(250);
      }
      return null;
    } finally {
      if (wasOn && prevTrack && prevTrack.languageCode) safeCall(player, 'setOption', 'captions', 'track', prevTrack);
      else {
        safeCall(player, 'setOption', 'captions', 'track', {});
        safeCall(player, 'unloadModule', 'captions');
      }
      for (const k of STICKY_KEYS) {
        try {
          if (savedLs[k] == null) localStorage.removeItem(k);
          else localStorage.setItem(k, savedLs[k]);
        } catch (_) {
          /* ignore */
        }
      }
      setTimeout(() => hide.remove(), 400);
    }
  }

  async function fetchWithPot(track, pot, fmt, tlang) {
    const u = new URL(track.baseUrl, location.origin);
    u.searchParams.set('pot', pot.pot);
    u.searchParams.set('potc', '1');
    u.searchParams.set('c', pot.c || 'WEB');
    if (pot.cver) u.searchParams.set('cver', pot.cver);
    u.searchParams.set('fmt', fmt);
    if (tlang) u.searchParams.set('tlang', tlang);
    else u.searchParams.delete('tlang');
    // The unhooked fetch: the caller gets the body, so the timedtext hook must not decode and cache it again.
    const res = nativeFetch ? await nativeFetch.call(window, u.toString(), { credentials: 'include' }) : await fetch(u.toString(), { credentials: 'include' });
    const body = await res.text();
    return res.ok && body && body.length > 2 ? body : null;
  }

  const CAPTION_FORMATS = ['json3', 'vtt', 'srv1', 'srv2', 'srv3', 'ttml'];

  /**
   * getCaptions({ videoId, languageCode, kind, vssId, tlang, fmt }) -> { body, fmt }
   * fmt: one of json3 | vtt | srv1 | srv2 | srv3 | ttml (default json3).
   * Error codes: bad_params | no_track | no_player | ad (an ad is playing and no token is known yet) | no_token | empty.
   */
  async function getCaptions(params) {
    const videoId = params.videoId;
    const fmt = CAPTION_FORMATS.includes(params.fmt) ? params.fmt : 'json3';
    const tlang = params.tlang || '';
    if (!videoId || !params.languageCode) throw Object.assign(new Error('missing videoId/languageCode'), { code: 'bad_params' });

    const cached = capGet([videoId, params.languageCode, params.kind || '', tlang, fmt].join('|'));
    if (cached) return { body: cached, fmt };

    const player = await waitForPlayer(videoId, params.surface, 3000);
    const resp = rawResponse(videoId, params.surface);
    const ctr = (resp && resp.captions && resp.captions.playerCaptionsTracklistRenderer) || {};
    const tracks = ctr.captionTracks || [];
    const kind = params.kind || '';
    const track =
      tracks.find((t) => t.languageCode === params.languageCode && (t.kind || '') === kind && (!params.vssId || t.vssId === params.vssId)) ||
      tracks.find((t) => t.languageCode === params.languageCode && (t.kind || '') === kind) ||
      tracks.find((t) => t.languageCode === params.languageCode);
    if (!track || !track.baseUrl) throw Object.assign(new Error('caption track not found'), { code: 'no_track' });

    let pot = freshPot(videoId);
    if (pot) {
      const body = await fetchWithPot(track, pot, fmt, tlang).catch(() => null);
      if (body) return { body, fmt };
      potByVideo.delete(videoId); // stale token
    }
    if (!player) throw Object.assign(new Error('player not found'), { code: 'no_player' });
    // During an ad the player's caption requests are for the ad's video: the trigger would only time out (~21 s).
    if (adShowing(player)) throw adError();
    pot = await triggerPot(player, videoId, track.languageCode);
    if (!pot) throw Object.assign(new Error('YouTube did not provide a caption token'), { code: 'no_token' });
    const body = await fetchWithPot(track, pot, fmt, tlang).catch(() => null);
    if (body) return { body, fmt };
    throw Object.assign(new Error('YouTube returned no caption data'), { code: 'empty' });
  }

  /* ------------------------------------------------------------------ Shorts guide entries */
  /** Marks guide/mini-guide Shorts entries with data-ayt-shorts (language independent, via Polymer data). */
  function tagShortsGuide() {
    let n = 0;
    document.querySelectorAll('ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer').forEach((el) => {
      let isShorts = false;
      try {
        const icon = el.data && el.data.icon && el.data.icon.iconType;
        isShorts = typeof icon === 'string' && /SHORTS/.test(icon);
      } catch (_) {
        /* ignore */
      }
      if (!isShorts) isShorts = !!el.querySelector('a[href="/shorts/"], a[href^="/shorts"]');
      if (isShorts) {
        el.setAttribute('data-ayt-shorts', '');
        n++;
      }
    });
    return n;
  }

  /* ------------------------------------------------------------------ handlers */
  const handlers = {
    ping: () => ({ ok: true, version: 2 }),

    getPlayerResponse,

    getPlayerState: (p) => {
      const player = findPlayer(p.videoId || null, p.surface);
      if (!player) return null;
      const v = videoEl(player);
      return {
        videoId: videoIdOf(player),
        currentTime: safeCall(player, 'getCurrentTime'),
        duration: safeCall(player, 'getDuration'),
        state: safeCall(player, 'getPlayerState'),
        rate: v ? v.playbackRate : safeCall(player, 'getPlaybackRate'),
        availableRates: safeCall(player, 'getAvailablePlaybackRates') || [],
        quality: safeCall(player, 'getPlaybackQuality'),
        qualities: safeCall(player, 'getAvailableQualityLevels') || [],
        qualityLabels: safeCall(player, 'getAvailableQualityLabels') || [],
        volume: safeCall(player, 'getVolume'),
        muted: safeCall(player, 'isMuted'),
        loop: !!safeCall(player, 'getLoopVideo'),
        loopRange: safeCall(player, 'getLoopRange') || null,
        isAd: player.classList.contains('ad-showing'),
        videoHeight: v ? v.videoHeight : 0,
      };
    },

    seekTo: (p) => {
      const t = Number(p.t);
      if (!isFinite(t) || t < 0) throw new Error('bad time');
      const player = findPlayer(null, p.surface);
      if (player && typeof player.seekTo === 'function') player.seekTo(t, true);
      else {
        const v = videoEl(player);
        if (v) v.currentTime = t;
      }
      return true;
    },

    /** YouTube's API clamps to 0.25..2; other rates (up to 16) are set on the <video> directly. */
    setPlaybackRate: (p) => {
      const rate = Number(p.rate);
      if (!(rate > 0 && rate <= 16)) throw new Error('bad rate');
      const player = findPlayer(null, p.surface);
      let viaApi = false;
      const rates = safeCall(player, 'getAvailablePlaybackRates') || [];
      if (rates.includes(rate)) {
        safeCall(player, 'setPlaybackRate', rate);
        viaApi = true;
      }
      const v = videoEl(player);
      if (v && Math.abs(v.playbackRate - rate) > 1e-3) v.playbackRate = rate;
      return { viaApi, rate: v ? v.playbackRate : rate };
    },

    setQuality: (p) => {
      const player = findPlayer(null, p.surface);
      if (!player) return false;
      const levels = safeCall(player, 'getAvailableQualityLevels') || [];
      const q = String(p.quality || '');
      if (!levels.includes(q)) return false;
      safeCall(player, 'setPlaybackQualityRange', q, q);
      return true;
    },

    getQualities: (p) => safeCall(findPlayer(null, p.surface), 'getAvailableQualityLevels') || [],

    setLoop: (p) => {
      const player = findPlayer(null, p.surface);
      const on = !!p.on;
      if (player && typeof player.setLoopVideo === 'function') {
        safeCall(player, 'setLoopVideo', on);
        return { viaApi: true };
      }
      const v = videoEl(player);
      if (v) v.loop = on;
      return { viaApi: false };
    },

    getLoop: (p) => {
      const player = findPlayer(null, p.surface);
      if (player && typeof player.getLoopVideo === 'function') return !!safeCall(player, 'getLoopVideo');
      const v = videoEl(player);
      return !!(v && v.loop);
    },

    /** Native A-B loop: setLoopRange({startTimeMs, endTimeMs}); pass start=end=null to clear. */
    setLoopRange: (p) => {
      const player = findPlayer(null, p.surface);
      if (!player || typeof player.setLoopRange !== 'function') return { supported: false };
      if (p.start == null || p.end == null) {
        safeCall(player, 'setLoopRange', null);
        return { supported: true, range: null };
      }
      const s = Math.max(0, Math.round(Number(p.start) * 1000));
      const e = Math.round(Number(p.end) * 1000);
      if (!(e > s)) throw new Error('bad range');
      safeCall(player, 'setLoopRange', { startTimeMs: s, endTimeMs: e });
      return { supported: true, range: safeCall(player, 'getLoopRange') || null };
    },

    getLoopRange: (p) => safeCall(findPlayer(null, p.surface), 'getLoopRange') || null,

    getCaptions,

    tagShortsGuide,
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__ayt !== BRIDGE || d.dir !== 'i2m' || !d.id) return;
    const fn = Object.prototype.hasOwnProperty.call(handlers, d.method) ? handlers[d.method] : null;
    if (!fn) {
      post({ re: d.id, ok: false, error: 'Unknown method ' + d.method, code: 'unknown_method' });
      return;
    }
    try {
      const result = await fn(d.params || {});
      post({ re: d.id, ok: true, result: result === undefined ? null : result });
    } catch (err) {
      post({ re: d.id, ok: false, error: (err && err.message) || String(err), code: (err && err.code) || 'error' });
    }
  });

  /* ------------------------------------------------------------------ video change events */
  let lastVid = null;
  function checkVideo() {
    const vid = videoIdOf(findPlayer(null));
    if (vid && vid !== lastVid) {
      lastVid = vid;
      emit('videochange', { videoId: vid });
    }
  }
  document.addEventListener('yt-player-updated', () => setTimeout(checkVideo, 0), true);
  document.addEventListener('yt-navigate-finish', () => setTimeout(checkVideo, 0), true);

  emit('ready', { version: 2 });
})();
