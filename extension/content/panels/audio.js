/*
 * Akif's Special YouTube Addon — DOWNLOADS module, part 2: the audio panel.
 *
 * Toolbar button 'audio' (group download, order 20, surfaces watch + shorts): MP3 at any bitrate (192 kbps
 * recommended, 320 best) or M4A / Opus (original stream, no re-encoding) / FLAC / WAV, an optional time range
 * (same editor as the video clip mode), audio language for dubbed videos, cover art + tags switches, whole
 * playlist mode, a live size estimate and a big download button whose label follows the choices.
 * Uses the helpers in AYT.dl (content/panels/video.js, loaded first).
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || !AYT.dl || AYT.dl.createAudioPanel) return;
  const DL = AYT.dl;
  const { h, icon, clear } = AYT.dom;
  const t = (k, p) => AYT.t(k, p);

  /* ------------------------------------------------------------------ labels */
  function bitrateOptions() {
    return AYT.MP3_BITRATES.map((n) => {
      let label;
      if (n === 320) label = t('audio.bitrateBest', { n });
      else if (n === AYT.RECOMMENDED_MP3_BITRATE) label = t('audio.bitrateRecommended', { n });
      else if (n === 128) label = t('audio.bitrateStandard', { n });
      else if (n === 64) label = t('audio.bitrateSmallest', { n });
      else label = t('audio.kbps', { n });
      return { value: n, label };
    });
  }

  function formatTitle(fmt) {
    switch (fmt) {
      case 'm4a':
        return t('audio.m4aTitle');
      case 'opus':
        return t('audio.opusTitle');
      case 'flac':
        return t('audio.flacTitle');
      case 'wav':
        return t('audio.wavTitle');
      default:
        return t('audio.mp3Title');
    }
  }

  function formatHint(fmt) {
    if (fmt === 'm4a' || fmt === 'opus') return t('audio.copyHint');
    if (fmt === 'flac' || fmt === 'wav') return t('audio.losslessHint');
    return '';
  }

  function buttonLabel(fmt, bitrate) {
    return fmt === 'mp3' ? t('audio.downloadMp3', { bitrate }) : t('audio.downloadFormat', { format: DL.AUDIO_LABEL[fmt] || fmt.toUpperCase() });
  }

  /* ------------------------------------------------------------------ styles */
  AYT.ui.addStyles(`
.ayt-audio-formats .ayt-seg { display: flex; width: 100%; }
.ayt-audio-formats .ayt-seg__opt { flex: 1 1 0; padding: 0 8px; letter-spacing: .3px; }
.ayt-audio-hint { display: flex; align-items: center; gap: 8px; margin-top: -4px; padding: 0 4px; font: 400 12.5px/1.4 var(--ayt-font); color: var(--ayt-text-2); }
.ayt-audio-hint .ayt-icon { flex: none; color: var(--ayt-accent); }
.ayt-audio-switches { gap: 0; padding: 4px 14px; }
.ayt-audio-switches .ayt-switch + .ayt-switch { border-top: 1px solid var(--ayt-border); }
.ayt-audio-summary { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 2px 4px 0; }
.ayt-audio-summary__label { font: 500 13px/1.2 var(--ayt-font); color: var(--ayt-text-2); }
.ayt-audio-estimate { font: 700 17px/1.2 var(--ayt-font); font-variant-numeric: tabular-nums; color: var(--ayt-text); white-space: nowrap; }
.ayt-audio-estimate small { font: 500 12px/1 var(--ayt-font); color: var(--ayt-text-3); margin-left: 6px; }
.ayt-audio-go { height: 46px; margin-top: -4px; border-radius: 14px; font-size: 15px; font-weight: 600; letter-spacing: .2px; }
.ayt-audio-go.is-blocked { opacity: .55; filter: saturate(.55); box-shadow: none; }
.ayt-audio-go.is-busy { pointer-events: none; }
.ayt-audio-go.is-busy .ayt-icon { animation: ayt-dl-bob .8s ease-in-out infinite alternate; }
/* estimate + Download button: part of the normal flow in the toolbar dropdown; in the short Shorts
   popover a bar that sticks to the bottom of the scrolling body so the main action never scrolls out
   of view. The body has 16 px side/bottom padding: the bar spans the full width, and bottom: -16px
   puts it flush with the visible edge (sticky offsets count from inside the scroller's padding). */
.ayt-audio-cta { display: contents; }
.ayt-dl--compact .ayt-audio-cta {
  display: flex; flex-direction: column; gap: 10px; position: sticky; bottom: -16px; z-index: 1;
  margin: 0 -16px; padding: 10px 16px 14px; background: var(--ayt-bg-solid); border-top: 1px solid var(--ayt-border);
}
.ayt-dl--compact .ayt-audio-cta .ayt-audio-go { margin-top: 0; }
`);

  /* ------------------------------------------------------------------ panel */
  function createAudioPanel(ctx) {
    const S = {
      videoId: ctx.videoId,
      listId: ctx.page && ctx.page.listId ? ctx.page.listId : null,
      info: null,
      seq: 0,
      destroyed: false,
      format: DL.AUDIO_FORMATS.includes(DL.settingOr('audioFormat', 'mp3')) ? DL.settingOr('audioFormat', 'mp3') : 'mp3',
      bitrate: DL.normBitrate(DL.settingOr('audioBitrate', AYT.RECOMMENDED_MP3_BITRATE)),
      embedThumbnail: !!DL.settingOr('embedThumbnail', true),
      embedMetadata: !!DL.settingOr('embedMetadata', true),
      trackId: null,
      range: null,
      section: null,
      playlist: false,
      starting: false,
      fit: {}, // DL.fitPanel() state for this open panel
      fitTimer: 0,
      autoFocus: !!ctx.viaKeyboard, // keyboard open: the selected format gets focus (once, see focusButton)
    };
    const root = h('div', { class: ['ayt-dl', 'ayt-audio', ctx.surface === 'shorts' && 'ayt-dl--compact'] });
    const host = DL.hostController(() => onHost());
    const footer = DL.folderFooter(() => host.status);
    let C = null;
    const offs = [];
    let resizeTimer = 0;

    /* ---------------------------------------------------------------- loading */
    function showLoading() {
      clear(root);
      root.appendChild(h('div', { class: 'ayt-dl-loading' }, AYT.ui.spinner(), h('span', null, t('audio.loading'))));
    }

    async function load(force) {
      const seq = ++S.seq;
      teardown();
      if (!DL.VIDEO_ID_RE.test(String(S.videoId || ''))) {
        clear(root);
        root.appendChild(AYT.ui.notice({ kind: 'warn', text: t('error.noVideo') }));
        return;
      }
      showLoading();
      try {
        const info = await DL.withTimeout(AYT.videoInfo.get(S.videoId, { force: !!force }), 15000);
        if (seq !== S.seq || S.destroyed) return;
        S.info = info;
        build(true);
      } catch (e) {
        if (seq !== S.seq || S.destroyed) return;
        clear(root);
        root.appendChild(
          AYT.ui.notice({
            kind: 'error',
            title: t('dl.loadFailed'),
            text: (e && e.message) || String(e),
            actions: [{ label: t('common.retry'), icon: 'refresh', variant: 'primary', onClick: () => load(true) }],
          })
        );
        fit();
      }
    }

    function teardown() {
      if (!C) return;
      if (C.jobList) C.jobList.destroy();
      if (C.range) C.range.destroy();
      C.offs.forEach((off) => off());
      C = null;
    }

    /* ---------------------------------------------------------------- build */
    function build(first) {
      teardown();
      const info = S.info;
      C = { offs: [], jobList: null, range: null };
      clear(root);
      const blocked = AYT.videoInfo.blockReason(info);
      if (blocked) {
        root.append(AYT.ui.notice({ kind: 'warn', text: blocked }), jobsSection());
        fit();
        return;
      }
      C.hostSlot = h('div', { class: 'ayt-dl-host' });

      // format + bitrate / hint
      C.formats = AYT.ui.segmented({
        ariaLabel: t('common.format'),
        value: S.format,
        options: DL.AUDIO_FORMATS.map((f) => ({ value: f, label: DL.AUDIO_LABEL[f], title: formatTitle(f) })),
        onChange: (v) => {
          S.format = DL.AUDIO_FORMATS.includes(v) ? v : 'mp3';
          DL.persist('audioFormat', S.format);
          updateFormat();
        },
      });
      C.bitrate = AYT.ui.select({
        ariaLabel: t('audio.bitrate'),
        value: S.bitrate,
        options: bitrateOptions(),
        onChange: (v) => {
          S.bitrate = DL.normBitrate(v);
          DL.persist('audioBitrate', S.bitrate);
          updateSummary();
        },
      });
      C.bitrateField = h('div', { class: 'ayt-audio-bitrate' }, AYT.ui.field(t('audio.bitrate'), C.bitrate.el));
      C.hintText = h('span');
      C.hint = h('div', { class: 'ayt-audio-hint' }, icon('sparkle', { size: 14 }), C.hintText);
      root.append(C.hostSlot, h('div', { class: 'ayt-audio-formats' }, C.formats.el), C.bitrateField, C.hint);

      // audio language
      const tracks = DL.trackOptions(info);
      C.tracks = tracks;
      if (tracks.length) {
        if (!S.trackId || !tracks.some((x) => x.value === S.trackId)) S.trackId = tracks[0].value;
        C.lang = AYT.ui.select({
          ariaLabel: t('dl.audioLanguage'),
          value: S.trackId,
          options: tracks.map((x) => ({ value: x.value, label: x.label })),
          onChange: (v) => {
            S.trackId = v;
            updateSummary();
          },
        });
        root.appendChild(h('div', { class: 'ayt-dl-lang' }, AYT.ui.field([icon('globe', { size: 14 }), t('dl.audioLanguage')], C.lang.el)));
      } else S.trackId = null;

      // time range (whole video by default)
      if (info.duration > DL.MIN_SECTION + 1) {
        C.range = DL.rangeEditor({
          duration: info.duration,
          start: S.range ? S.range.start : 0,
          end: S.range ? S.range.end : info.duration,
          onChange: (r) => {
            S.range = { start: r.start, end: r.end };
            S.section = r.section;
            updateSummary();
          },
        });
        S.section = C.range.section;
        C.rangeCard = h('div', { class: 'ayt-dl-card ayt-audio-range' }, C.range.el);
        root.appendChild(C.rangeCard);
      }

      // switches
      C.cover = AYT.ui.switchControl({
        label: t('audio.cover'),
        desc: t('audio.coverDesc'),
        checked: S.embedThumbnail,
        onChange: (v) => {
          S.embedThumbnail = !!v;
          DL.persist('embedThumbnail', S.embedThumbnail);
          updateSummary();
        },
      });
      C.tags = AYT.ui.switchControl({
        label: t('audio.tags'),
        desc: t('audio.tagsDesc'),
        checked: S.embedMetadata,
        onChange: (v) => {
          S.embedMetadata = !!v;
          DL.persist('embedMetadata', S.embedMetadata);
        },
      });
      const switches = [C.cover.el, C.tags.el];
      if (DL.playlistOk(S.listId) && ctx.surface !== 'shorts') {
        C.playlist = AYT.ui.switchControl({
          label: t('dl.playlist'),
          desc: t('audio.playlistDesc'),
          checked: S.playlist,
          onChange: (v) => {
            S.playlist = !!v;
            if (C.rangeCard) C.rangeCard.classList.toggle('ayt-hidden', S.playlist);
            updateSummary();
            fit();
          },
        });
        switches.push(C.playlist.el);
      }
      root.appendChild(h('div', { class: 'ayt-dl-card ayt-audio-switches' }, switches));
      if (C.rangeCard) C.rangeCard.classList.toggle('ayt-hidden', S.playlist);

      // estimate + primary button (sticky at the bottom of the Shorts popover, see .ayt-audio-cta)
      C.estimate = h('span', { class: 'ayt-audio-estimate' });
      C.go = AYT.ui.button({ icon: 'download', label: ' ', variant: 'primary', block: true, className: 'ayt-audio-go', onClick: onDownload });
      root.appendChild(
        h('div', { class: 'ayt-audio-cta' }, h('div', { class: 'ayt-audio-summary' }, h('span', { class: 'ayt-audio-summary__label' }, t('dl.estimated')), C.estimate), C.go)
      );

      root.appendChild(jobsSection());
      updateFormat();
      renderHost();
      if (first) focusButton();
      fit();
    }

    function jobsSection() {
      const title = h('div', { class: 'ayt-dl-section-title ayt-hidden' }, t('common.downloads'));
      const vid = S.videoId;
      C.jobList = AYT.ui.jobList({
        filter: (j) => j.videoId === vid && j.kind === 'audio',
        compact: true,
        max: 8,
        onChange: (jobs) => title.classList.toggle('ayt-hidden', !jobs.length),
      });
      return h('div', { class: 'ayt-col ayt-audio-jobs' }, title, C.jobList.el);
    }

    function currentTrack() {
      return (C && C.tracks && C.tracks.find((x) => x.value === S.trackId)) || null;
    }

    /* ---------------------------------------------------------------- updates */
    function updateFormat() {
      if (!C) return;
      const fmt = S.format;
      if (C.formats.value !== fmt) C.formats.value = fmt;
      C.bitrateField.classList.toggle('ayt-hidden', fmt !== 'mp3');
      const hint = formatHint(fmt);
      C.hintText.textContent = hint;
      C.hint.classList.toggle('ayt-hidden', !hint);
      // WAV can't hold cover art (yt-dlp fails) — show it off/disabled without touching the saved setting.
      const wav = fmt === 'wav';
      C.cover.disabled = wav;
      C.cover.checked = wav ? false : S.embedThumbnail;
      const desc = C.cover.el.querySelector('.ayt-switch__desc');
      if (desc) desc.textContent = wav ? t('audio.coverWav') : t('audio.coverDesc');
      updateSummary();
    }

    function updateSummary() {
      if (!C || !C.go) return;
      const track = currentTrack();
      const est = DL.estimateAudio(S.info, {
        format: S.format,
        bitrate: S.bitrate,
        trackId: track ? track.value : null,
        lang: track ? track.lang : null,
        section: S.playlist ? null : S.section,
        embedThumbnail: S.embedThumbnail,
      });
      clear(C.estimate);
      C.estimate.append(DL.formatSize(est.size, est.approx) || t('common.unknown'));
      if (S.playlist) C.estimate.appendChild(h('small', null, t('dl.perVideo')));
      const span = C.go.querySelector('span');
      if (span) span.textContent = S.starting ? t('job.status.starting') : buttonLabel(S.format, S.bitrate);
      C.go.classList.toggle('is-busy', S.starting);
      C.go.classList.toggle('is-blocked', host.blocked);
      C.go.setAttribute('aria-disabled', String(host.blocked || S.starting));
    }

    /**
     * Keyboard opens only: focus the selected format (←/→ switch formats). After a mouse open focus stays on the
     * panel container (toolbar.js), so Space keeps controlling the video. Once per open (a later video change leaves
     * focus alone), and only while focus is still on the panel container (DL.focusUntouched).
     */
    function focusButton() {
      if (!S.autoFocus) return;
      S.autoFocus = false;
      setTimeout(() => {
        if (!C || !C.go || S.destroyed || !DL.focusUntouched(root)) return;
        try {
          C.formats.el.querySelector('.is-selected').focus({ preventScroll: true });
        } catch (_) {
          /* ignore */
        }
      }, 60);
    }

    async function onDownload() {
      if (!C || S.starting) return;
      try {
        if (host.blocked) return DL.needCompanion(host.status, 'audio', C.hostSlot);
        const track = currentTrack();
        const audioLang = track && !track.isOriginal ? track.lang : null;
        const playlistId = S.playlist ? S.listId : null;
        const section = S.playlist ? null : S.section;
        const task = DL.audioTask(S.videoId, {
          format: S.format,
          bitrate: S.bitrate,
          audioLang,
          section,
          playlistId,
          embedThumbnail: S.embedThumbnail,
          embedMetadata: S.embedMetadata,
        });
        const label = DL.audioLabel({ format: S.format, bitrate: S.bitrate, langName: audioLang ? track.name : '', section, duration: S.info.duration, playlistId });
        S.starting = true;
        updateSummary();
        if (!(await host.ensure())) {
          DL.needCompanion(host.status, 'audio', C && C.hostSlot);
          return;
        }
        await DL.startJob(task, DL.videoMeta(S.videoId, S.info.title, label), { host, kind: 'audio', pulseEl: C && C.hostSlot });
      } catch (e) {
        AYT.ui.showError(e);
      } finally {
        S.starting = false;
        updateSummary();
      }
    }

    /* ---------------------------------------------------------------- host */
    function renderHost() {
      if (!C || !C.hostSlot) return;
      clear(C.hostSlot);
      if (host.blocked) C.hostSlot.appendChild(AYT.ui.hostNotice(host.status, { onRecheck: () => {} }));
      updateSummary();
    }

    function onHost() {
      renderHost();
      footer.update();
      fit();
    }

    function fit() {
      if (S.destroyed) return;
      requestAnimationFrame(() => {
        if (S.destroyed || !DL.fitPanel(root, ctx, S.fit, !!S.info)) return;
        clearTimeout(S.fitTimer);
        S.fitTimer = setTimeout(fit, 1300); // re-measure once the scroll settled
      });
    }

    /* ---------------------------------------------------------------- global listeners */
    offs.push(
      AYT.settings.onChange((changes) => {
        if (!C) {
          if ('outputDir' in changes || 'subfolder' in changes) footer.update();
          return;
        }
        let dirty = false;
        if ('audioFormat' in changes && changes.audioFormat !== S.format && DL.AUDIO_FORMATS.includes(changes.audioFormat)) {
          S.format = changes.audioFormat;
          dirty = true;
        }
        if ('audioBitrate' in changes && DL.normBitrate(changes.audioBitrate) !== S.bitrate) {
          S.bitrate = DL.normBitrate(changes.audioBitrate);
          C.bitrate.value = S.bitrate;
          dirty = true;
        }
        if ('embedThumbnail' in changes && !!changes.embedThumbnail !== S.embedThumbnail) {
          S.embedThumbnail = !!changes.embedThumbnail;
          dirty = true;
        }
        if ('embedMetadata' in changes && !!changes.embedMetadata !== S.embedMetadata) {
          S.embedMetadata = !!changes.embedMetadata;
          C.tags.checked = S.embedMetadata;
        }
        if (dirty) updateFormat();
        if ('outputDir' in changes || 'subfolder' in changes) footer.update();
      })
    );
    offs.push(
      AYT.i18n.onChange(() => {
        footer.update();
        if (S.info) build(false);
      })
    );
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fit, 150);
    };
    window.addEventListener('resize', onResize);
    offs.push(() => window.removeEventListener('resize', onResize));

    showLoading();
    load(false);

    return {
      el: root,
      footer: footer.el,
      onOpen() {
        host.refresh(false);
        fit();
      },
      onVideoChange(pageInfo) {
        if (!pageInfo || !pageInfo.videoId || pageInfo.videoId === S.videoId) return;
        S.videoId = pageInfo.videoId;
        S.listId = pageInfo.listId || null;
        Object.assign(S, { info: null, trackId: null, range: null, section: null, playlist: false, starting: false });
        // YouTube scrolls to the top on navigation: let the panel fit itself again for the new video
        clearTimeout(S.fitTimer);
        S.fit = {};
        load(false);
      },
      destroy() {
        if (S.destroyed) return;
        S.destroyed = true;
        S.seq++;
        teardown();
        host.destroy();
        offs.forEach((off) => off());
        clearTimeout(resizeTimer);
        clearTimeout(S.fitTimer);
      },
    };
  }

  DL.createAudioPanel = createAudioPanel;

  if (AYT.toolbar && typeof AYT.toolbar.register === 'function') {
    AYT.toolbar.register({
      id: 'audio',
      order: 20,
      group: 'download',
      icon: 'music',
      panelIcon: 'music',
      title: () => t('toolbar.audio'),
      panelTitle: () => t('audio.panelTitle'),
      surfaces: ['watch', 'shorts'],
      panel: { width: 460, render: (ctx) => createAudioPanel(ctx) },
      progress: () => DL.toolbarProgress(['audio']),
    });
  }
})(globalThis);
