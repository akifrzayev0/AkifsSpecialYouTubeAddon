/*
 * Akif's Special YouTube Addon — subtitles panel (owner: MEDIA).
 *
 * In-browser path: AYT.videoInfo.fetchCaptions (MAIN-world PO-token recipe) in the wanted native format
 * (vtt / ttml / srv3; SRT and TXT are built from json3 with AYT.subtitles) -> DOWNLOAD_DATA.
 * When the browser can't get the captions and the companion app is connected, a kind:'subtitle' job is
 * started instead (yt-dlp). Not while an ad plays (error code 'ad': the player would fetch the ad's captions):
 * the panel says so and downloads again by itself once the ad is over.
 *
 * Testable API (used by tools/e2e/media.e2e.mjs and tools/tests/subtitles.test.mjs):
 *   AYT.captions.defaultTrack(tracks) -> index
 *   AYT.captions.trackLabel(track) -> option label (auto-generated tracks marked with a gear)
 *   AYT.captions.translationOptions(info, track) -> [{ lang, name }] ("Translate to" list)
 *   AYT.captions.translationName(info, tlang) -> name of a translation language
 *   AYT.captions.errorText(err) -> friendly text for a caption error (by err.code, e.g. 'no_token', 'ad')
 *   Language names follow the extension's language; YouTube's own names (written in YouTube's UI language)
 *   are only kept when both languages are the same, or when the uploader gave a track its own title.
 *   AYT.captions.prepare({ videoId, track, tlang, format, info }) -> { text, mime, ext, cues, sourceFormat, filename }
 *   AYT.captions.save(opts) -> prepare() + download   ·   AYT.captions.copy(opts) -> plain text on the clipboard
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || AYT.captions || !AYT.media) return;
  const { h, icon, clear } = AYT.dom;
  const t = (k, p) => AYT.t(k, p);
  const U = AYT.util;
  const M = AYT.media;

  /** Gear-like marker for auto-generated tracks (U+FE0E: text presentation, not an emoji). */
  const GEAR = '⚙︎';
  const FETCH_TIMEOUT_MS = 45000;
  const MAX_AD_RETRIES = 3; // automatic download retries after ads (an ad break can hold several ads)
  const AD_RETRY_MS = 3 * 60000; // ...and all of them start within 3 minutes of the click
  const FORMAT_NAME = { srt: 'SRT', vtt: 'WebVTT', ttml: 'TTML', srv3: 'SRV3', txt: 'TXT' };

  /* ------------------------------------------------------------------ tracks */

  const dnCache = new Map(); // 'lang|style' -> Intl.DisplayNames | null

  function displayNames(lang, style) {
    const key = lang + '|' + style;
    if (!dnCache.has(key)) {
      let dn = null;
      try {
        dn = new Intl.DisplayNames([lang], { type: 'language', languageDisplay: style, fallback: 'none' });
      } catch (_) {
        dn = null;
      }
      dnCache.set(key, dn);
    }
    return dnCache.get(key);
  }

  function nameIn(lang, style, code) {
    const dn = lang ? displayNames(lang, style) : null;
    try {
      return (dn && dn.of(code)) || null;
    } catch (_) {
      return null; // invalid language tag
    }
  }

  /**
   * Language name in the extension's language (YouTube's own names follow YouTube's UI language, which
   * can differ). Same helper as the audio-language select (AYT.dl, video.js); `fallback` when unknown.
   */
  function languageName(code, fallback) {
    if (AYT.dl && typeof AYT.dl.languageName === 'function') return AYT.dl.languageName(code, fallback);
    return (code && nameIn(AYT.i18n.language, 'dialect', code)) || fallback || code || '';
  }

  /** YouTube's UI language (<html lang>): its names for languages and tracks are written in it. */
  function youtubeLang() {
    return String((document.documentElement && document.documentElement.lang) || '');
  }
  const baseLang = (s) => String(s || '').toLowerCase().split('-')[0];

  /** Name of a language in the extension's language; YouTube's own name when both UIs use the same language. */
  function localName(code, youtubeName) {
    if (youtubeName && baseLang(youtubeLang()) === baseLang(AYT.i18n.language)) return youtubeName;
    return languageName(code, youtubeName);
  }

  /** True when YouTube's track name is just the name of the language (in YouTube's UI language or English). */
  function isPlainLanguageName(name, code) {
    const n = String(name || '').trim().toLowerCase();
    if (!n || !code) return false;
    for (const lang of [youtubeLang(), 'en']) {
      for (const style of ['standard', 'dialect']) {
        const x = nameIn(lang, style, code);
        if (x && x.toLowerCase() === n) return true;
      }
    }
    return false;
  }

  /**
   * Track name without YouTube's "(auto-generated)" suffix, in the extension's language when YouTube's
   * name is just the language ("English" → "İngilizce"); a title the uploader gave the track
   * ("English - CC") is kept.
   */
  function baseName(track) {
    const n = String(track.name || '').trim();
    const yt = track.isAuto ? n.replace(/\s*\([^()]*\)\s*$/, '').trim() : n;
    if (!yt) return languageName(track.lang);
    return isPlainLanguageName(yt, track.lang) ? localName(track.lang, yt) : yt;
  }

  function trackLabel(track) {
    return track.isAuto ? GEAR + ' ' + t('subtitles.autoTrack', { name: baseName(track) }) : baseName(track);
  }

  /** settings.subtitleLang -> UI language -> spoken language (auto track) -> first manual -> first auto. */
  function defaultTrack(tracks) {
    if (!tracks || !tracks.length) return -1;
    const prefs = [];
    try {
      const p = AYT.settings.get('subtitleLang');
      if (p) prefs.push(String(p));
    } catch (_) {
      /* settings not loaded */
    }
    prefs.push(AYT.i18n.language);
    const spoken = tracks.find((tr) => tr.isAuto);
    if (spoken) prefs.push(spoken.lang);
    const lower = (s) => String(s || '').toLowerCase();
    const base = (s) => lower(s).split('-')[0];
    for (const pref of prefs) {
      const p = lower(pref);
      const tests = [
        (tr) => !tr.isAuto && lower(tr.lang) === p,
        (tr) => !tr.isAuto && base(tr.lang) === base(p),
        (tr) => tr.isAuto && lower(tr.lang) === p,
        (tr) => tr.isAuto && base(tr.lang) === base(p),
      ];
      for (const test of tests) {
        const i = tracks.findIndex(test);
        if (i >= 0) return i;
      }
    }
    const manual = tracks.findIndex((tr) => !tr.isAuto);
    return manual >= 0 ? manual : 0;
  }

  /**
   * Translation targets [{lang, name}] with names in the extension's language: the UI language first,
   * then alphabetical in the UI language; the track's own language is left out.
   */
  function translationOptions(info, track) {
    const ui = AYT.i18n.language;
    const own = String(track.lang || '').toLowerCase().split('-')[0];
    const langs = ((info.captions && info.captions.translationLanguages) || [])
      .filter((l) => l && l.lang && String(l.lang).toLowerCase().split('-')[0] !== own)
      .map((l) => ({ lang: l.lang, name: localName(l.lang, l.name || l.lang) }));
    let compare;
    try {
      compare = new Intl.Collator(ui).compare;
    } catch (_) {
      compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    }
    const first = langs.filter((l) => l.lang === ui);
    const rest = langs.filter((l) => l.lang !== ui).sort((a, b) => compare(a.name, b.name));
    return first.concat(rest);
  }

  function translationName(info, tlang) {
    const l = ((info && info.captions && info.captions.translationLanguages) || []).find((x) => x.lang === tlang);
    return localName(tlang, l && l.name);
  }

  /* ------------------------------------------------------------------ fetching */

  /** Friendly text for errors of AYT.videoInfo.fetchCaptions / AYT.subtitles (codes: see video-info.js). */
  function captionError(err) {
    switch (err && err.code) {
      case 'no_token':
        return t('subtitles.err.noToken');
      case 'empty':
        return t('subtitles.err.empty');
      case 'no_track':
      case 'bad_params':
        return t('subtitles.err.noTrack');
      case 'no_player':
        return t('subtitles.err.noPlayer');
      case 'timeout':
        return t('subtitles.err.timeout');
      case 'parse':
      case 'format':
        return t('subtitles.err.parse');
      case 'ad':
        // the player shows an ad: its caption requests (and token) would be the ad's (main-world.js)
        return t('subtitles.err.ad');
      default:
        return M.errorText(err);
    }
  }

  function checkOpts(o) {
    if (!o || !o.videoId || !o.track || !o.track.lang) throw M.codedError(t('subtitles.err.noTrack'), 'no_track');
    const format = String(o.format || 'srt');
    if (!AYT.subtitles.FORMATS.includes(format)) throw M.codedError(t('subtitles.err.parse'), 'format');
    return format;
  }

  /**
   * Fetches a caption track in the format needed for `format` and converts it.
   * Native vtt/ttml/srv3 are requested directly; if YouTube's file can't be used, json3 is converted instead.
   */
  async function prepare(o) {
    const format = checkOpts(o);
    const track = o.track;
    const tlang = o.tlang || '';
    const wanted = AYT.subtitles.sourceFormat(format);
    const order = wanted === 'json3' ? ['json3'] : [wanted, 'json3'];
    let lastError = null;
    for (const fmt of order) {
      try {
        const res = await M.withTimeout(
          AYT.videoInfo.fetchCaptions({ videoId: o.videoId, lang: track.lang, kind: track.kind || '', vssId: track.vssId || '', tlang, fmt }),
          FETCH_TIMEOUT_MS
        );
        const body = res && typeof res.body === 'string' ? res.body : '';
        if (!body) throw M.codedError(t('subtitles.err.empty'), 'empty');
        const out = AYT.subtitles.convert(body, (res && res.fmt) || fmt, format, { lang: tlang || track.lang });
        const fi = await M.fileInfo(o.videoId, o.info);
        const suffix = tlang ? track.lang + '→' + tlang : track.lang;
        return Object.assign(out, { sourceFormat: (res && res.fmt) || fmt, filename: M.filename(fi, out.ext, suffix) });
      } catch (e) {
        lastError = e;
        // Only a conversion problem is worth another try in json3 (token/track problems would repeat).
        if (!(e && (e.code === 'parse' || e.code === 'format' || e.code === 'empty'))) break;
      }
    }
    throw lastError || M.codedError(t('subtitles.err.empty'), 'empty');
  }

  /** prepare() + download through the extension (page fallback). */
  async function save(o) {
    const out = await prepare(o);
    const res = await M.saveText(out.text, out.mime, out.filename, 'subtitle');
    return Object.assign(out, { via: res.via });
  }

  /** Plain transcript of a track on the clipboard. */
  function copy(o) {
    const opts = Object.assign({}, o, { format: 'txt' });
    return M.copyText(prepare(opts).then((out) => out.text));
  }

  /** Companion fallback (yt-dlp). Resolves the job id. */
  function startJob(o, info) {
    const track = o.track;
    const tlang = o.tlang || null;
    const label = [FORMAT_NAME[o.format] || o.format, baseName(track) + (track.isAuto ? ' ' + GEAR : '') + (tlang ? ' → ' + translationName(info, tlang) : '')].join(' · ');
    return AYT.client.jobs.start(
      {
        kind: 'subtitle',
        videoId: o.videoId,
        url: U.watchUrl(o.videoId),
        playlist: false,
        subLang: track.lang,
        subAuto: !!track.isAuto,
        subFormat: o.format,
        subTranslateTo: tlang,
      },
      {
        title: (info && info.title) || o.videoId,
        videoId: o.videoId,
        thumbnail: 'https://i.ytimg.com/vi/' + o.videoId + '/mqdefault.jpg',
        label,
      }
    );
  }

  AYT.captions = { GEAR, defaultTrack, trackLabel, baseName, translationOptions, translationName, errorText: captionError, prepare, save, copy, startJob };

  /* ------------------------------------------------------------------ panel */

  AYT.ui.addStyles(`
.ayt-subs { display: flex; flex-direction: column; gap: 14px; }
.ayt-subs__legend { display: flex; align-items: center; gap: 7px; margin-top: 1px; font: 400 12px/1.4 var(--ayt-font); color: var(--ayt-text-3); }
.ayt-subs__gear { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 5px; background: var(--ayt-surface-2); color: var(--ayt-text-2); font: 400 12px/1 "Segoe UI Symbol", var(--ayt-font); }
.ayt-subs__formats .ayt-radio-list { gap: 0; }
.ayt-subs__formats .ayt-radio { padding: 7px 10px; gap: 11px; }
.ayt-subs__formats .ayt-radio__dot { width: 18px; height: 18px; }
.ayt-subs__formats .ayt-radio__dot::after { width: 8px; height: 8px; }
/* label column + description column: long (translated) descriptions wrap inside their own column */
.ayt-subs__formats .ayt-radio__text { display: grid; grid-template-columns: 66px minmax(0, 1fr); align-items: baseline; column-gap: 8px; row-gap: 1px; }
.ayt-subs__formats .ayt-radio__desc { font-size: 12.5px; }
.ayt-subs__count { margin-left: auto; font: 500 12px/1 var(--ayt-font); color: var(--ayt-text-3); }
.ayt-subs__fallback { display: flex; flex-direction: column; gap: 10px; }
.ayt-subs__fallback:empty { display: none; }
`);

  function renderPanel(ctx) {
    let videoId = ctx.videoId;
    let gen = 0;
    let destroyed = false;
    let info = null;
    let busy = false;
    let jobs = null; // AYT.ui.jobList for subtitle jobs of this video
    let viewOffs = []; // listeners of the currently rendered view
    const panelOffs = []; // listeners for the panel's whole lifetime
    const root = h('div', { class: 'ayt-subs' });

    function clearView() {
      viewOffs.forEach((off) => off());
      viewOffs = [];
      if (jobs) jobs.destroy();
      jobs = null;
      busy = false;
    }

    function jobFilter(id) {
      return (j) => j.videoId === id && j.kind === 'subtitle';
    }

    function showLoading() {
      clear(root);
      root.appendChild(h('div', { class: 'ayt-row-flex ayt-muted' }, AYT.ui.spinner(), h('span', null, t('common.loading'))));
    }

    function showProblem(my, opts) {
      if (my !== gen || destroyed) return;
      clear(root);
      root.appendChild(AYT.ui.notice(opts));
    }

    async function load(force) {
      const my = ++gen;
      clearView();
      showLoading();
      const vid = videoId;
      try {
        info = await M.withTimeout(vid === ctx.videoId ? ctx.getInfo(force) : AYT.videoInfo.get(vid, { force: !!force }), 15000);
      } catch (e) {
        showProblem(my, {
          kind: 'error',
          title: t('subtitles.err.info'),
          text: M.errorText(e),
          actions: [{ label: t('common.retry'), icon: 'refresh', onClick: () => load(true) }],
        });
        return;
      }
      if (my !== gen || destroyed) return;
      const tracks = (info.captions && info.captions.tracks) || [];
      if (!tracks.length) {
        const reason = AYT.videoInfo.blockReason(info);
        showProblem(my, { kind: 'info', title: t('subtitles.none'), text: reason || t('subtitles.noneHint') });
        return;
      }
      renderMain(my, tracks);
    }

    function renderMain(my, tracks) {
      clear(root);
      const status = M.statusLine();
      const fallback = h('div', { class: 'ayt-subs__fallback' });
      let trackIndex = defaultTrack(tracks);
      let adTimer = 0; // waiting for an ad to end before downloading again (see waitForAdEnd)
      let adRetries = 0; // automatic retries since the last click
      let adDeadline = 0; // no automatic retry starts after this (AD_RETRY_MS after the click)

      /** A new choice or action replaces the last result (and a pending retry after an ad). */
      function resetStatus() {
        stopAdWait();
        status.clear();
      }

      // language
      const langSelect = AYT.ui.select({
        options: tracks.map((tr, i) => ({ value: String(i), label: trackLabel(tr) })),
        value: String(trackIndex),
        ariaLabel: t('common.language'),
        onChange: (v) => {
          trackIndex = Number(v);
          refreshTranslate();
          resetStatus();
        },
      });
      const autoCount = tracks.filter((tr) => tr.isAuto).length;
      const legend = autoCount
        ? h('div', { class: 'ayt-subs__legend' }, h('span', { class: 'ayt-subs__gear', 'aria-hidden': 'true' }, GEAR), h('span', null, t('subtitles.autoLegend')))
        : null;
      const langLabel = h('span', { class: 'ayt-row-flex', style: 'width: 100%' }, h('span', null, t('common.language')), h('span', { class: 'ayt-subs__count' }, t('subtitles.trackCount', { count: tracks.length })));

      // translation
      const translate = AYT.ui.select({ options: [], ariaLabel: t('subtitles.translateTo'), onChange: () => resetStatus() });
      const translateField = AYT.ui.field(t('subtitles.translateTo'), translate.el, t('subtitles.translateHint'));
      function refreshTranslate() {
        const track = tracks[trackIndex];
        const langs = track && track.isTranslatable ? translationOptions(info, track) : [];
        translateField.classList.toggle('ayt-hidden', !langs.length);
        const keep = translate.value;
        translate.setOptions([{ value: '', label: t('subtitles.dontTranslate') }].concat(langs.map((l) => ({ value: l.lang, label: l.name }))), '');
        if (keep && langs.some((l) => l.lang === keep)) translate.value = keep;
      }
      refreshTranslate();

      // format
      const currentFormat = () => {
        const f = AYT.settings.get('subtitleFormat');
        return AYT.subtitles.FORMATS.includes(f) ? f : 'srt';
      };
      const formats = AYT.ui.radioList({
        ariaLabel: t('common.format'),
        value: currentFormat(),
        options: [
          { value: 'srt', label: 'SRT', desc: t('subtitles.fmtSrt') },
          { value: 'vtt', label: 'WebVTT', desc: t('subtitles.fmtVtt') },
          { value: 'ttml', label: 'TTML', desc: t('subtitles.fmtTtml') },
          { value: 'srv3', label: 'SRV3', desc: t('subtitles.fmtSrv3') },
          { value: 'txt', label: 'TXT', desc: t('subtitles.fmtTxt') },
        ],
        onChange: (v) => {
          AYT.settings.set('subtitleFormat', v).catch(() => {});
          updateDownloadLabel();
          resetStatus();
        },
      });

      // The label must be non-empty here: AYT.ui.button only creates the label <span> for a label.
      const downloadBtn = AYT.ui.button({ label: t('media.downloadAs', { format: FORMAT_NAME[formats.value] || 'SRT' }), icon: 'download', variant: 'primary', onClick: () => onDownload() });
      const copyBtn = AYT.ui.button({ label: t('subtitles.copyText'), icon: 'copy', title: t('subtitles.copyTextHint'), onClick: () => onCopy() });
      function updateDownloadLabel() {
        const span = downloadBtn.querySelector('span');
        if (span) span.textContent = t('media.downloadAs', { format: FORMAT_NAME[formats.value] || 'SRT' });
      }
      updateDownloadLabel();

      // Companion (yt-dlp) subtitle jobs of this video, hidden while there are none. Always mounted: the list holds
      // the live port, whose snapshot also brings earlier jobs (a tab only syncs its job list at start while a
      // download is active, see boot.js).
      jobs = AYT.ui.jobList({ filter: jobFilter(videoId), compact: true, max: 5 });

      root.append(
        AYT.ui.field(langLabel, h('div', { class: 'ayt-col', style: 'gap: 7px' }, langSelect.el, legend)),
        translateField,
        h('div', { class: 'ayt-field ayt-subs__formats' }, h('div', { class: 'ayt-label' }, t('common.format')), formats.el),
        h('div', { class: 'ayt-media-actions' }, downloadBtn, copyBtn),
        status.el,
        fallback,
        jobs.el
      );

      viewOffs.push(stopAdWait);
      viewOffs.push(
        AYT.settings.onChange((c) => {
          if ('subtitleFormat' in c && formats.value !== c.subtitleFormat && AYT.subtitles.FORMATS.includes(c.subtitleFormat)) {
            formats.value = c.subtitleFormat;
            updateDownloadLabel();
          }
        })
      );

      function selection() {
        return { videoId, track: tracks[trackIndex], tlang: translate.value || '', format: formats.value, info };
      }

      function setBusy(on) {
        busy = on;
        downloadBtn.disabled = copyBtn.disabled = on;
        langSelect.disabled = translate.disabled = on;
      }

      /** auto: the retry after an ad (waitForAdEnd), not a click. */
      async function onDownload(auto) {
        if (busy) return;
        const sel = selection();
        stopAdWait();
        if (!auto) {
          adRetries = 0;
          adDeadline = Date.now() + AD_RETRY_MS;
        }
        setBusy(true);
        clear(fallback);
        status.busy(t('subtitles.preparing'));
        try {
          await save(sel);
          if (my === gen && !destroyed) status.success(t('media.downloadStarted'));
        } catch (e) {
          if (my !== gen || destroyed) return;
          if (e && (e.code === 'invalidated' || e.code === 'ad')) {
            // No companion fallback: the page needs a refresh / the browser path works again once the ad is over.
            status.error(captionError(e));
            if (e.code === 'ad' && adRetries < MAX_AD_RETRIES) {
              adRetries++;
              waitForAdEnd();
            }
          } else await companionFallback(sel, e);
        } finally {
          if (my === gen && !destroyed) setBusy(false);
        }
      }

      function stopAdWait() {
        clearInterval(adTimer);
        adTimer = 0;
      }

      /**
       * After a download failed because an ad was playing: try again on its own once the ad is over, as long as this
       * view is still shown with the same choices and nothing else was started (a few times for an ad break with
       * several ads, but every retry starts within 3 minutes of the click: the deadline is not renewed per wait).
       */
      function waitForAdEnd() {
        stopAdWait();
        if (Date.now() >= adDeadline) return;
        let clearSince = 0;
        adTimer = setInterval(() => {
          if (my !== gen || destroyed || Date.now() > adDeadline) return stopAdWait();
          let ad = false;
          try {
            ad = AYT.player.isAdPlaying();
          } catch (_) {
            ad = false;
          }
          if (ad || busy) {
            clearSince = 0;
            return;
          }
          // give the player a moment to switch back to the video (and its caption module)
          if (!clearSince) clearSince = Date.now();
          if (Date.now() - clearSince < 1500) return;
          stopAdWait();
          onDownload(true);
        }, 500);
      }

      async function companionFallback(sel, err) {
        const reason = captionError(err);
        status.busy(t('subtitles.tryingCompanion'));
        let hostStatus = AYT.client.host.status;
        try {
          hostStatus = await M.withTimeout(AYT.client.host.refresh(false), 8000);
        } catch (_) {
          /* service worker unavailable: treated as "not connected" */
        }
        if (my !== gen || destroyed) return;
        if (hostStatus && hostStatus.state === 'connected') {
          try {
            await startJob(sel, info);
            if (my !== gen || destroyed) return;
            status.clear();
            clear(fallback);
            // the new job shows up in the job list right below
            fallback.appendChild(AYT.ui.notice({ kind: 'info', title: t('subtitles.companionStarted'), text: reason }));
            return;
          } catch (e2) {
            if (my !== gen || destroyed) return;
            status.error(t('subtitles.failed', { message: reason + ' · ' + M.errorText(e2) }));
            return;
          }
        }
        status.error(t('subtitles.failed', { message: reason }));
        clear(fallback);
        fallback.appendChild(
          AYT.ui.hostNotice(hostStatus, {
            // "not installed" notice: what the companion would do here
            text: t('subtitles.companionHint'),
            // Companion installed in the meantime: run the download through it right away.
            onRecheck: (s) => {
              if (s && s.state === 'connected' && my === gen && !destroyed && !busy) {
                setBusy(true);
                companionFallback(sel, err).finally(() => {
                  if (my === gen && !destroyed) setBusy(false);
                });
              }
            },
          })
        );
      }

      function onCopy() {
        if (busy) return;
        const sel = selection();
        stopAdWait();
        setBusy(true);
        status.busy(t('subtitles.preparing'));
        copy(sel).then(
          () => {
            if (my === gen && !destroyed) status.success(t('subtitles.copied'));
          },
          (e) => {
            if (my === gen && !destroyed) status.error(t('subtitles.copyFailed', { message: captionError(e) }));
          }
        ).finally(() => {
          if (my === gen && !destroyed) setBusy(false);
        });
      }
    }

    panelOffs.push(AYT.i18n.onChange(() => load(false)));
    load(false);

    return {
      el: root,
      onVideoChange(pageInfo) {
        if (!pageInfo || !pageInfo.videoId || pageInfo.videoId === videoId) return;
        videoId = pageInfo.videoId;
        info = null;
        load(false);
      },
      destroy() {
        destroyed = true;
        gen++;
        clearView();
        panelOffs.forEach((off) => off());
        panelOffs.length = 0;
      },
    };
  }

  /** Newest active subtitle job of the current video (toolbar progress ring). */
  function activeJob() {
    const id = AYT.page.videoId;
    return AYT.client.jobs.active().find((j) => j.videoId === id && j.kind === 'subtitle') || null;
  }

  AYT.toolbar.register({
    id: 'subtitles',
    order: 40,
    group: 'download',
    icon: 'cc',
    title: () => t('toolbar.subtitles'),
    panelTitle: () => t('toolbar.subtitles'),
    surfaces: ['watch', 'shorts'],
    progress: () => {
      const j = activeJob();
      return j ? j.percent || 0 : null;
    },
    panel: { width: 460, render: renderPanel },
  });
})(globalThis);
