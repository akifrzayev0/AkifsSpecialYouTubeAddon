/*
 * Akif's Special YouTube Addon — Picture-in-picture tool (owner: TOOLS).
 *
 * Toolbar action `pip` (group tools, order 50) and command `toggle-pip`.
 * Uses the standard requestPictureInPicture() on the active <video> (removing
 * disablePictureInPicture first) and document.exitPictureInPicture().
 * Keyboard commands arrive without a user gesture in the page; when Chrome refuses
 * (NotAllowedError) a toast offers a button that retries from a real click.
 *
 * Public: AYT.tools.pip = { toggle(), isOn() }
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || !AYT.toolbar || !AYT.dom || !AYT.ui) return;
  const NS = (AYT.tools = AYT.tools || {});
  if (NS.pip) return;
  const t = (k, p) => AYT.t(k, p);

  function coded(message, code, name) {
    const e = new Error(message);
    e.code = code;
    if (name) e.name = name;
    return e;
  }

  const isOn = () => !!document.pictureInPictureElement;

  /** Enters or leaves picture-in-picture. Resolves the new state (true = in PiP). */
  async function toggle() {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return false;
    }
    if (!document.pictureInPictureEnabled) throw coded(t('tools.pip.unsupported'), 'unsupported');
    const v = AYT.player.video();
    if (!v) throw coded(t('error.noVideo'), 'no_video');
    if (v.readyState < 1) throw coded(t('tools.pip.notReady'), 'not_ready');
    try {
      if (v.disablePictureInPicture) v.disablePictureInPicture = false;
      v.removeAttribute('disablepictureinpicture');
    } catch (_) {
      /* ignore */
    }
    let timer = 0;
    try {
      // Never leave the user without feedback: some environments never settle the promise.
      await Promise.race([
        v.requestPictureInPicture(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(coded(t('tools.pip.timeout'), 'timeout')), 5000);
        }),
      ]);
    } catch (e) {
      if (e && e.code === 'timeout') throw e;
      if (e && e.name === 'NotAllowedError') throw coded(t('tools.pip.needClick'), 'gesture', 'NotAllowedError');
      throw coded(t('tools.pip.failed', { message: (e && e.message) || String(e) }), 'pip');
    } finally {
      clearTimeout(timer);
    }
    return !!document.pictureInPictureElement;
  }

  async function command() {
    try {
      await toggle();
    } catch (e) {
      if (e && e.code === 'gesture') {
        // The command came from a keyboard shortcut: put focus on "Open", so Enter/Space (a real gesture) opens PiP.
        AYT.ui.toast(t('tools.pip.needClick'), {
          kind: 'info',
          duration: 8000,
          focusAction: true,
          action: { label: t('common.open'), onClick: () => toggle().catch((err) => AYT.ui.showError(err)) },
        });
      } else AYT.ui.showError(e);
    }
    refresh();
  }

  function refresh() {
    try {
      AYT.toolbar.refresh();
    } catch (_) {
      /* ignore */
    }
  }

  AYT.toolbar.register({
    id: 'pip',
    group: 'tools',
    order: 50,
    icon: 'pip',
    title: () => t('toolbar.pip'),
    isOn,
    onClick: () => toggle(),
    commands: { 'toggle-pip': () => command() },
  });

  AYT.features.register({
    id: 'pip',
    init() {
      // enter/leavepictureinpicture are dispatched at the <video>: listen in the capture phase.
      document.addEventListener('enterpictureinpicture', refresh, true);
      document.addEventListener('leavepictureinpicture', refresh, true);
    },
  });

  NS.pip = { toggle, isOn, command };
})(globalThis);
