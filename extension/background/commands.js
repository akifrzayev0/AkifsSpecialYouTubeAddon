/*
 * Akif's Special YouTube Addon — keyboard commands (owner: BACKGROUND, spec §7.5).
 *
 * chrome.commands.onCommand -> if the active tab is a YouTube tab, the command is forwarded to its content
 * script as { __aytPush: true, type: AYT.PUSH.COMMAND, command } (AYT.client emits 'command'; boot.js routes it
 * to the toolbar/feature `commands` maps).
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  const t = (key, params) => AYT.t(key, params);

  const COMMANDS = ['take-screenshot', 'open-download', 'toggle-loop', 'toggle-cinema', 'toggle-pip', 'toggle-comments', 'speed-up', 'speed-down', 'speed-reset'];
  const hintedTabs = new Set();

  function isYouTubeTab(tab) {
    try {
      const u = new URL((tab && (tab.url || tab.pendingUrl)) || '');
      return u.protocol === 'https:' && u.hostname === 'www.youtube.com';
    } catch (_) {
      return false;
    }
  }

  async function activeTab(tab) {
    if (tab && tab.id >= 0 && (tab.url || tab.pendingUrl)) return tab;
    try {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return active || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Forwards a command to the active YouTube tab. Returns true when a content script received it.
   * @param {string} command
   * @param {chrome.tabs.Tab} [tab]
   */
  async function forward(command, tab) {
    if (!COMMANDS.includes(command)) return false;
    const target = await activeTab(tab);
    if (!target || !isYouTubeTab(target)) return false;
    try {
      await chrome.tabs.sendMessage(target.id, { __aytPush: true, type: AYT.PUSH.COMMAND, command }, { frameId: 0 });
      return true;
    } catch (e) {
      const message = String((e && e.message) || e);
      if (/receiving end does not exist|could not establish connection/i.test(message) && !hintedTabs.has(target.id)) {
        // The tab was opened before the extension was installed/updated: its content scripts are missing.
        hintedTabs.add(target.id);
        AYT.bg.notify('ayt-reload-hint', { title: t('background.reloadTab.title'), message: t('background.reloadTab.text') });
      }
      return false;
    }
  }

  try {
    chrome.commands.onCommand.addListener((command, tab) => {
      forward(command, tab).catch((e) => console.error('[AYT] command failed', command, e));
    });
  } catch (e) {
    console.warn('[AYT] commands unavailable', e);
  }

  AYT.commands = { COMMANDS, forward, isYouTubeTab };
})(globalThis);
