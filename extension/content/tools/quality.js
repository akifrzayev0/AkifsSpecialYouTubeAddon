/*
 * Akif's Special YouTube Addon — Auto quality (owner: TOOLS).
 *
 * Feature (no toolbar button): when the setting autoQuality is not 'off', after each new video
 * (watch + Shorts) it waits for the player (and for a running ad to finish), reads the available
 * levels (bridge getPlayerState → qualities = getAvailableQualityLevels()) and sets
 *   'max'              → the first non-'auto' level (YouTube lists them best first)
 *   '<height>' (1080…) → the highest level whose height is ≤ the preferred height
 *                        (the lowest available level when all are higher)
 * through the bridge `setQuality` (setPlaybackQualityRange). Once per video, plus one retry after
 * an ad finishes (YouTube may reset the quality after an ad break). A level chosen by the user
 * afterwards is respected.
 *
 * Public: AYT.tools.quality = { pickQuality(levels, pref), apply(force), state() }
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || !AYT.features || !AYT.bridge) return;
  const NS = (AYT.tools = AYT.tools || {});
  if (NS.quality) return;
  const U = AYT.util;

  /** 'hd1080' → 1080 (from AYT.QUALITY_IDS). */
  const HEIGHT = {};
  for (const [height, id] of Object.entries(AYT.QUALITY_IDS || {})) HEIGHT[id] = Number(height);

  /**
   * Picks the level to request. levels: YouTube quality ids (e.g. ['hd2160', …, 'auto']);
   * pref: 'max' | '4320' | '2160' | … | '360' | 'off'. Returns an id or null.
   */
  function pickQuality(levels, pref) {
    if (!pref || pref === 'off' || !Array.isArray(levels)) return null;
    const valid = levels.filter((l) => typeof l === 'string' && l && l !== 'auto');
    if (!valid.length) return null;
    if (pref === 'max') return valid[0];
    const target = Number(pref);
    if (!(target > 0)) return null;
    const known = valid.filter((l) => HEIGHT[l] != null).sort((a, b) => HEIGHT[b] - HEIGHT[a]);
    if (!known.length) return null;
    return known.find((l) => HEIGHT[l] <= target) || known[known.length - 1];
  }

  const setting = (name) => {
    try {
      return AYT.settings.get(name);
    } catch (_) {
      return AYT.DEFAULT_SETTINGS[name];
    }
  };

  let token = 0;
  let timer = 0;
  let adObserver = null;
  let last = { videoId: null, quality: null, ok: null, retried: false, at: 0 };

  function stopAdWatch() {
    if (adObserver) adObserver.disconnect();
    adObserver = null;
  }

  async function setLevel(quality, surface) {
    try {
      return (await AYT.bridge.request('setQuality', { quality, surface }, 3000)) === true;
    } catch (_) {
      return false;
    }
  }

  /** Waits for the player of `videoId`, then applies the preferred level. */
  async function run(videoId, surface) {
    const my = ++token;
    stopAdWatch();
    const pref = setting('autoQuality');
    if (!videoId || !pref || pref === 'off') return null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (my !== token) return null;
      if (!AYT.player.isAdPlaying()) {
        let s = null;
        try {
          s = await AYT.bridge.request('getPlayerState', { surface }, 3000);
        } catch (_) {
          s = null;
        }
        if (my !== token) return null;
        if (s && s.videoId === videoId && !s.isAd) {
          const pick = pickQuality(s.qualities, pref);
          if (pick) {
            const ok = await setLevel(pick, surface);
            if (my !== token) return null;
            last = { videoId, quality: pick, ok, retried: false, at: Date.now() };
            watchAds(videoId, surface, my, pref);
            return pick;
          }
        }
      }
      await U.sleep(700);
    }
    return null;
  }

  /** One retry after the next ad break of this video ends. */
  function watchAds(videoId, surface, my, pref) {
    const root = AYT.player.root();
    if (!root || typeof MutationObserver !== 'function') return;
    let wasAd = AYT.player.isAdPlaying();
    adObserver = new MutationObserver(() => {
      const ad = root.classList.contains('ad-showing') || root.classList.contains('ad-interrupting');
      if (ad === wasAd) return;
      wasAd = ad;
      if (ad || my !== token || last.retried) return;
      last.retried = true;
      stopAdWatch();
      setTimeout(async () => {
        if (my !== token || AYT.page.videoId !== videoId) return;
        let levels = [];
        try {
          levels = await AYT.bridge.request('getQualities', { surface }, 3000);
        } catch (_) {
          levels = [];
        }
        const pick = pickQuality(levels, pref);
        if (pick && my === token) {
          last.ok = await setLevel(pick, surface);
          last.quality = pick;
        }
      }, 800);
    });
    adObserver.observe(root, { attributes: true, attributeFilter: ['class'] });
  }

  function schedule(info, delay) {
    clearTimeout(timer);
    if (!info || !info.videoId || (info.type !== 'watch' && info.type !== 'shorts')) {
      token++;
      stopAdWatch();
      return;
    }
    if (setting('autoQuality') === 'off') return;
    timer = setTimeout(() => {
      run(info.videoId, info.type).catch(() => {});
    }, delay == null ? 300 : delay);
  }

  AYT.features.register({
    id: 'quality',
    init() {
      schedule(AYT.page.info, 600);
    },
    onPageChange(info, prev) {
      if (info.videoId !== prev.videoId || info.type !== prev.type) schedule(info);
    },
    onSettings(changes) {
      if ('autoQuality' in changes) {
        if (changes.autoQuality === 'off') {
          token++;
          stopAdWatch();
        } else schedule(AYT.page.info, 0);
      }
    },
  });

  NS.quality = {
    pickQuality,
    HEIGHT,
    apply: () => run(AYT.page.videoId, AYT.page.type),
    state: () => Object.assign({}, last),
  };
})(globalThis);
