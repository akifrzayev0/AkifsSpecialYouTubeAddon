/*
 * Akif's Special YouTube Addon — VideoInfo: normalized metadata for the current video.
 *
 *   const info = await AYT.videoInfo.get(videoId, { force: false });
 *   const cached = AYT.videoInfo.peek(videoId);            // sync, may be null
 *   const { body, fmt } = await AYT.videoInfo.fetchCaptions({ videoId, lang, kind, vssId, tlang });
 *
 * Source: the page's player response (via the MAIN-world bridge). Since 2025/2026 the web player
 * streams through SABR, so formats carry metadata (size, resolution, HDR, codecs) but no URLs —
 * the actual download is always done by the companion app (yt-dlp).
 *
 * VideoInfo = {
 *   videoId, title, author, channelId, duration (s), publishDate, uploadDate,
 *   isLive, isLiveContent, isUpcoming, isPrivate, playable, status, reason, drm,
 *   thumbnails: [{ url, width, height }],
 *   videoFormats: [{ itag, container:'mp4'|'webm', codec:'h264'|'vp9'|'av1'|..., width, height, res, fps, hdr,
 *                    bitrate, size, sizeApprox, qualityLabel, muxed }]          (sorted: res desc, fps desc, hdr first)
 *   audioFormats: [{ itag, container:'m4a'|'webm', codec:'aac'|'opus'|..., bitrate, size, sizeApprox, sampleRate,
 *                    channels, lang, langName, isDefault, isOriginal, isDrc }]   (sorted: bitrate desc)
 *   audioTracks:  [{ id, lang, name, isDefault, isOriginal }]                    (only when the video has several)
 *   captions: { tracks: [{ lang, name, kind, isAuto, vssId, isTranslatable }], translationLanguages: [{ lang, name }] },
 *   fetchedAt
 * }
 * `res` is YouTube's resolution label, the number in `qualityLabel` (2160 for "2160p"; 1080 for a letterboxed
 * 1920×800 and for a vertical 1080×1920 video); the short side only when a format has no label.
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (AYT.videoInfo) return;

  const TTL = 5 * 60 * 1000;
  const cache = new Map();
  const inflight = new Map();

  function codecOf(mime) {
    const m = /codecs="([^"]+)"/.exec(mime || '');
    const c = (m ? m[1] : '').toLowerCase();
    if (c.startsWith('avc1') || c.startsWith('avc3')) return 'h264';
    if (c.startsWith('vp09') || c.startsWith('vp9')) return 'vp9';
    if (c.startsWith('av01')) return 'av1';
    if (c.startsWith('hev1') || c.startsWith('hvc1')) return 'hevc';
    if (c.startsWith('mp4a')) return 'aac';
    if (c.startsWith('opus')) return 'opus';
    if (c.startsWith('ec-3')) return 'eac3';
    if (c.startsWith('ac-3')) return 'ac3';
    return c.split('.')[0] || 'unknown';
  }

  function containerOf(mime) {
    const m = /^(video|audio)\/([a-z0-9]+)/i.exec(mime || '');
    if (!m) return 'unknown';
    if (m[2] === 'mp4') return m[1] === 'audio' ? 'm4a' : 'mp4';
    return m[2];
  }

  function isHdr(f) {
    if (/HDR/i.test(f.qualityLabel || '')) return true;
    const tc = (f.colorInfo && f.colorInfo.transferCharacteristics) || '';
    return /SMPTEST2084|ARIB_STD_B67/i.test(tc);
  }

  function resOf(f) {
    const m = /^(\d{3,4})p/.exec(f.qualityLabel || '');
    if (m) return Number(m[1]);
    if (f.width && f.height) return Math.min(f.width, f.height);
    return f.height || 0;
  }

  /** Decodes the xtags protobuf just enough to read acont (original/dubbed/descriptive) and lang. */
  function parseXtags(xtags) {
    if (!xtags) return {};
    try {
      const bin = atob(String(xtags).replace(/-/g, '+').replace(/_/g, '/'));
      const out = {};
      const re = /(acont|lang|drc|vb)\x12[\s\S]([A-Za-z0-9_-]+)/g;
      let m;
      while ((m = re.exec(bin))) out[m[1]] = m[2];
      return out;
    } catch (_) {
      return {};
    }
  }

  function sizeOf(f, durationSec) {
    const n = Number(f.contentLength);
    if (n > 0) return { size: n, approx: false };
    const ms = Number(f.approxDurationMs) || durationSec * 1000;
    const br = Number(f.averageBitrate || f.bitrate);
    if (ms > 0 && br > 0) return { size: Math.round((br * ms) / 8000), approx: true };
    return { size: null, approx: true };
  }

  function normalize(raw) {
    const vd = raw.videoDetails || {};
    const mf = raw.microformat || {};
    const sd = raw.streamingData || {};
    const ps = raw.playabilityStatus || {};
    const duration = Number(vd.lengthSeconds) || 0;
    const all = [].concat((sd.adaptiveFormats || []).map((f) => [f, false]), (sd.formats || []).map((f) => [f, true]));
    const videoFormats = [];
    const audioFormats = [];
    let drm = !!(sd.drmFamilies && sd.drmFamilies.length);

    for (const [f, muxed] of all) {
      if (f.drmFamilies && f.drmFamilies.length) drm = true;
      const mime = f.mimeType || '';
      const { size, approx } = sizeOf(f, duration);
      if (/^video\//.test(mime)) {
        videoFormats.push({
          itag: f.itag,
          container: containerOf(mime),
          codec: codecOf(mime),
          width: f.width || 0,
          height: f.height || 0,
          res: resOf(f),
          fps: f.fps || 30,
          hdr: isHdr(f),
          bitrate: f.bitrate || 0,
          size,
          sizeApprox: approx,
          qualityLabel: f.qualityLabel || '',
          muxed,
        });
      } else if (/^audio\//.test(mime)) {
        const tags = parseXtags(f.xtags);
        const at = f.audioTrack || null;
        const lang = at && at.id ? at.id.split('.')[0] : tags.lang || null;
        audioFormats.push({
          itag: f.itag,
          container: containerOf(mime),
          codec: codecOf(mime),
          bitrate: f.averageBitrate || f.bitrate || 0,
          size,
          sizeApprox: approx,
          sampleRate: Number(f.audioSampleRate) || null,
          channels: f.audioChannels || null,
          lang,
          langName: at ? at.displayName : null,
          trackId: at ? at.id : null,
          isDefault: at ? !!at.audioIsDefault : true,
          isOriginal: tags.acont ? tags.acont === 'original' : !!(at && at.audioIsDefault),
          isDrc: !!f.isDrc || tags.drc === '1',
        });
      }
    }

    videoFormats.sort((a, b) => b.res - a.res || b.fps - a.fps || Number(b.hdr) - Number(a.hdr) || b.bitrate - a.bitrate);
    audioFormats.sort((a, b) => Number(a.isDrc) - Number(b.isDrc) || b.bitrate - a.bitrate);

    const tracksById = new Map();
    for (const a of audioFormats) {
      if (!a.trackId || tracksById.has(a.trackId)) continue;
      tracksById.set(a.trackId, { id: a.trackId, lang: a.lang, name: a.langName || a.lang, isDefault: a.isDefault, isOriginal: a.isOriginal });
    }
    const audioTracks = tracksById.size > 1 ? Array.from(tracksById.values()).sort((a, b) => Number(b.isOriginal) - Number(a.isOriginal) || Number(b.isDefault) - Number(a.isDefault) || String(a.name).localeCompare(String(b.name))) : [];

    const caps = raw.captions || {};
    const captionTracks = (caps.tracks || []).map((t) => ({
      lang: t.languageCode,
      name: t.name || t.languageCode,
      kind: t.kind || '',
      isAuto: t.kind === 'asr',
      vssId: t.vssId || '',
      isTranslatable: !!t.isTranslatable,
    }));
    captionTracks.sort((a, b) => Number(a.isAuto) - Number(b.isAuto) || String(a.name).localeCompare(String(b.name)));

    const thumbs = (vd.thumbnails && vd.thumbnails.length ? vd.thumbnails : mf.thumbnails || []).map((t) => ({ url: t.url, width: t.width || 0, height: t.height || 0 }));

    return {
      videoId: vd.videoId,
      title: vd.title || '',
      author: vd.author || '',
      channelId: vd.channelId || '',
      duration,
      publishDate: mf.publishDate || null,
      uploadDate: mf.uploadDate || null,
      isLive: !!vd.isLive,
      isLiveContent: !!vd.isLiveContent,
      isUpcoming: !!vd.isUpcoming,
      isPrivate: !!vd.isPrivate,
      playable: (ps.status || 'OK') === 'OK',
      status: ps.status || 'OK',
      reason: ps.reason || '',
      drm,
      thumbnails: thumbs,
      videoFormats,
      audioFormats,
      audioTracks,
      captions: {
        tracks: captionTracks,
        translationLanguages: (caps.translationLanguages || []).map((l) => ({ lang: l.languageCode, name: l.name || l.languageCode })),
      },
      fetchedAt: Date.now(),
    };
  }

  function fail(key, params, code) {
    const e = new Error(AYT.t(key, params));
    e.code = code || key;
    return e;
  }

  AYT.videoInfo = {
    normalize,
    parseXtags,

    peek(videoId) {
      const c = cache.get(videoId);
      return c && Date.now() - c.at < TTL ? c.info : null;
    },

    /** Loads VideoInfo for videoId (must be the video currently loaded in a player on this page). */
    get(videoId, opts) {
      const force = !!(opts && opts.force);
      if (!videoId) return Promise.reject(fail('error.noVideo', null, 'no_video'));
      const c = cache.get(videoId);
      if (!force && c && Date.now() - c.at < TTL) return Promise.resolve(c.info);
      if (inflight.has(videoId)) return inflight.get(videoId);
      const p = AYT.bridge
        .request('getPlayerResponse', { videoId, surface: AYT.page.type, timeoutMs: 6000 }, 9000)
        .then((raw) => {
          if (!raw || !raw.videoDetails || raw.videoDetails.videoId !== videoId) throw fail('videoInfo.unavailable', null, 'no_info');
          const info = normalize(raw);
          cache.set(videoId, { info, at: Date.now() });
          if (cache.size > 30) cache.delete(cache.keys().next().value);
          return info;
        })
        .finally(() => inflight.delete(videoId));
      inflight.set(videoId, p);
      return p;
    },

    /**
     * Captions for a track in a native YouTube format.
     * params: { videoId, lang, kind, vssId, tlang, fmt: 'json3'|'vtt'|'srv1'|'srv2'|'srv3'|'ttml' (default json3) }
     * Resolves { body, fmt }. Throws with .code: no_track | no_token | empty | no_player | timeout | bad_params |
     * ad (an ad is playing and YouTube has not given a caption token for this video yet: retry after the ad;
     * the page-side message is English only, so map the code to a translated text).
     */
    fetchCaptions(params) {
      return AYT.bridge.request(
        'getCaptions',
        {
          videoId: params.videoId,
          languageCode: params.lang,
          kind: params.kind || '',
          vssId: params.vssId || '',
          tlang: params.tlang || '',
          fmt: params.fmt || 'json3',
          surface: AYT.page.type,
        },
        30000
      );
    },

    /** Human readable reason why downloads are not possible (or null when they are). */
    blockReason(info) {
      if (!info) return AYT.t('error.noVideo');
      if (info.drm) return AYT.t('error.drm');
      if (info.isUpcoming) return AYT.t('error.upcoming');
      if (info.isLive) return AYT.t('error.live');
      if (!info.playable) return AYT.t('error.unplayable', { reason: info.reason || info.status });
      return null;
    },
  };
})(globalThis);
