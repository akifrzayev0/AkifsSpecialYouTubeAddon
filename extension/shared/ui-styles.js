/*
 * Akif's Special YouTube Addon — design system CSS (single source of truth).
 * Used inside the content-script shadow roots (adoptedStyleSheets) and by the popup/options pages.
 * Theme: put class "ayt-root" and data-theme="dark|light" on a container (or :host).
 *
 * Colour tokens meet WCAG AA in both themes on every surface below (panel, cards, rows, popup, options):
 *   --ayt-text, --ayt-text-2, --ayt-text-3     text (text-3 for hints/descriptions; >= 4.5:1)
 *   --ayt-accent                               brand red for fills, borders, icons, sliders (not small text)
 *   --ayt-accent-text                          red TEXT (>= 4.5:1, also on --ayt-accent-soft)
 *   --ayt-accent-fill / --ayt-accent-fill-hover  red background behind white text (>= 4.5:1)
 *   --ayt-success, --ayt-danger                status text/icons/borders; *-fill variants go behind white text
 *   --ayt-warning-text                         amber TEXT ("finished with problems"; --ayt-warning is for icons/fills)
 *   --ayt-focus                                keyboard focus ring (blue, so it never reads as an error)
 */
(function (g) {
  'use strict';
  const AYT = (g.AYT = g.AYT || {});

  AYT.UI_CSS = String.raw`
:host, .ayt-root {
  --ayt-font: "Roboto", "YouTube Sans", "Segoe UI", system-ui, -apple-system, Arial, sans-serif;
  --ayt-radius: 16px;
  --ayt-radius-sm: 10px;
  --ayt-radius-xs: 7px;
  --ayt-accent: #ff2d46;
  --ayt-accent-2: #ff5b61;
  --ayt-accent-3: #c8102e;
  --ayt-accent-glow: rgba(255, 45, 70, 0.55);
  --ayt-accent-soft: rgba(255, 45, 70, 0.14);
  --ayt-accent-text: #ff6474;
  --ayt-accent-fill: linear-gradient(135deg, #e0283e, #c8102e);
  --ayt-accent-fill-hover: linear-gradient(135deg, #c8102e, #a50d26);
  --ayt-success: #22c55e;
  --ayt-success-fill: #15803d;
  --ayt-warning: #f59e0b;
  --ayt-warning-text: #fbbf24;
  --ayt-danger: #f87171;
  --ayt-danger-fill: #dc2626;
  --ayt-danger-fill-hover: #b91c1c;
  --ayt-info: #3ea6ff;
  --ayt-focus: #3ea6ff;
  --ayt-ease: cubic-bezier(.2, .8, .2, 1);

  /* dark (default) */
  --ayt-bg: #16161a; /* opaque: panels/toasts have no backdrop blur (see .ayt-panel) */
  --ayt-bg-solid: #16161a;
  --ayt-bg-elev: #202026;
  --ayt-surface: rgba(255, 255, 255, 0.055);
  --ayt-surface-2: rgba(255, 255, 255, 0.09);
  --ayt-surface-hover: rgba(255, 255, 255, 0.11);
  --ayt-border: rgba(255, 255, 255, 0.10);
  --ayt-border-strong: rgba(255, 255, 255, 0.18);
  --ayt-text: #f5f5f7;
  --ayt-text-2: #b4b4bd;
  --ayt-text-3: #9898a3;
  --ayt-badge-bg: rgba(255, 255, 255, 0.13);
  --ayt-badge-text: #e6e6ea;
  --ayt-shadow: 0 24px 60px rgba(0, 0, 0, 0.55), 0 4px 14px rgba(0, 0, 0, 0.35);
  --ayt-tb-hover: rgba(255, 255, 255, 0.10);
  --ayt-tb-active: rgba(255, 255, 255, 0.16);
  --ayt-scrim: rgba(0, 0, 0, 0.5);
  color-scheme: dark;
  font-family: var(--ayt-font);
  color: var(--ayt-text);
}
:host([data-theme="light"]), .ayt-root[data-theme="light"] {
  --ayt-accent: #e3122b;
  --ayt-accent-2: #ff3b4e;
  --ayt-accent-glow: rgba(227, 18, 43, 0.42);
  --ayt-accent-soft: rgba(227, 18, 43, 0.09);
  --ayt-accent-text: #c8102e;
  --ayt-success: #11733a;
  --ayt-warning-text: #9c4a00;
  --ayt-danger: #b91c1c;
  --ayt-focus: #1a73e8;
  --ayt-bg: #ffffff;
  --ayt-bg-solid: #ffffff;
  --ayt-bg-elev: #f6f6f8;
  --ayt-surface: rgba(0, 0, 0, 0.04);
  --ayt-surface-2: rgba(0, 0, 0, 0.065);
  --ayt-surface-hover: rgba(0, 0, 0, 0.075);
  --ayt-border: rgba(0, 0, 0, 0.10);
  --ayt-border-strong: rgba(0, 0, 0, 0.18);
  --ayt-text: #0f0f12;
  --ayt-text-2: #50505a;
  --ayt-text-3: #66666f;
  --ayt-badge-bg: rgba(0, 0, 0, 0.08);
  --ayt-badge-text: #2a2a30;
  --ayt-shadow: 0 24px 60px rgba(0, 0, 0, 0.18), 0 4px 14px rgba(0, 0, 0, 0.10);
  --ayt-tb-hover: rgba(0, 0, 0, 0.06);
  --ayt-tb-active: rgba(0, 0, 0, 0.10);
  --ayt-scrim: rgba(0, 0, 0, 0.25);
  color-scheme: light;
}

.ayt-root *, .ayt-root *::before, .ayt-root *::after,
:host *, :host *::before, :host *::after { box-sizing: border-box; }

.ayt-icon { flex: none; display: block; }
.ayt-hidden { display: none !important; }
.ayt-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.ayt-muted { color: var(--ayt-text-2); }
.ayt-small { font-size: 12px; }
.ayt-grow { flex: 1 1 auto; min-width: 0; }
.ayt-row-flex { display: flex; align-items: center; gap: 8px; }
.ayt-col { display: flex; flex-direction: column; gap: 10px; }
.ayt-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------------------------------------------------------------- buttons */
.ayt-btn {
  all: unset;
  box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: 36px; padding: 0 16px;
  border-radius: 999px;
  font: 500 14px/1 var(--ayt-font);
  color: var(--ayt-text);
  background: var(--ayt-surface-2);
  cursor: pointer; user-select: none; white-space: nowrap;
  transition: background .15s var(--ayt-ease), transform .1s var(--ayt-ease), box-shadow .2s var(--ayt-ease), opacity .15s;
}
.ayt-btn:hover { background: var(--ayt-surface-hover); }
.ayt-btn:active { transform: scale(.97); }
.ayt-btn:focus-visible { outline: 2px solid var(--ayt-focus); outline-offset: 2px; }
.ayt-btn[disabled], .ayt-btn.is-disabled { opacity: .45; cursor: not-allowed; pointer-events: none; }
.ayt-btn--primary {
  color: #fff;
  background: var(--ayt-accent-fill);
  box-shadow: 0 6px 18px var(--ayt-accent-glow);
}
.ayt-btn--primary:hover { background: var(--ayt-accent-fill-hover); box-shadow: 0 8px 24px var(--ayt-accent-glow); }
.ayt-btn--ghost { background: transparent; }
.ayt-btn--ghost:hover { background: var(--ayt-surface-hover); }
.ayt-btn--danger { color: #fff; background: var(--ayt-danger-fill); }
.ayt-btn--danger:hover { background: var(--ayt-danger-fill-hover); }
.ayt-btn--sm { height: 30px; padding: 0 12px; font-size: 13px; gap: 6px; }
.ayt-btn--block { display: flex; width: 100%; }
.ayt-btn--icon { width: 36px; padding: 0; }
.ayt-btn--icon.ayt-btn--sm { width: 30px; }
.ayt-btn.is-active { background: var(--ayt-accent-soft); color: var(--ayt-accent-text); }

/* ---------------------------------------------------------------- form controls */
.ayt-field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.ayt-label { font: 500 13px/1.3 var(--ayt-font); color: var(--ayt-text-2); display: flex; align-items: center; gap: 6px; }
.ayt-hint { font: 400 12px/1.4 var(--ayt-font); color: var(--ayt-text-3); }

.ayt-select-wrap { position: relative; display: block; min-width: 0; }
.ayt-select {
  appearance: none; -webkit-appearance: none;
  width: 100%; height: 40px;
  padding: 0 38px 0 14px;
  border-radius: var(--ayt-radius-sm);
  border: 1px solid var(--ayt-border-strong);
  background: var(--ayt-surface);
  color: var(--ayt-text);
  font: 400 14px/1 var(--ayt-font);
  cursor: pointer; outline: none;
  transition: border-color .15s, background .15s;
  text-overflow: ellipsis;
}
.ayt-select:hover { background: var(--ayt-surface-hover); }
.ayt-select:focus-visible { outline: 2px solid var(--ayt-focus); outline-offset: 2px; }
.ayt-select option, .ayt-select optgroup { background: var(--ayt-bg-solid); color: var(--ayt-text); }
.ayt-select-wrap .ayt-icon { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--ayt-text-2); }
.ayt-select[disabled] { opacity: .5; cursor: not-allowed; }

.ayt-input {
  width: 100%; height: 40px; padding: 0 12px;
  border-radius: var(--ayt-radius-sm);
  border: 1px solid var(--ayt-border-strong);
  background: var(--ayt-surface);
  color: var(--ayt-text);
  font: 400 14px/1 var(--ayt-font);
  outline: none;
  transition: border-color .15s, background .15s;
}
.ayt-input:focus { background: var(--ayt-surface-2); }
.ayt-input:focus-visible { outline: 2px solid var(--ayt-focus); outline-offset: 2px; }
.ayt-input.is-invalid { border-color: var(--ayt-danger); box-shadow: inset 0 0 0 1px var(--ayt-danger); }
/* message under a field (AYT.ui.timeInput errorEl): icon + text, so the error is not told by colour alone */
.ayt-field-error { display: flex; align-items: flex-start; gap: 5px; margin-top: 4px; font: 500 12px/1.35 var(--ayt-font); color: var(--ayt-danger); }
.ayt-field-error .ayt-icon { flex: none; margin-top: 1px; }
.ayt-input--time { font-variant-numeric: tabular-nums; letter-spacing: .5px; text-align: center; max-width: 140px; }

/* segmented control */
.ayt-seg {
  display: inline-flex; padding: 3px; gap: 2px;
  border-radius: 999px; background: var(--ayt-surface-2);
  max-width: 100%; overflow-x: auto; scrollbar-width: none;
}
.ayt-seg::-webkit-scrollbar { display: none; }
.ayt-seg__opt {
  all: unset; box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 30px; padding: 0 13px; border-radius: 999px;
  font: 500 13px/1 var(--ayt-font); color: var(--ayt-text-2);
  cursor: pointer; white-space: nowrap;
  transition: background .15s, color .15s, box-shadow .2s;
}
.ayt-seg__opt:hover { color: var(--ayt-text); }
.ayt-seg__opt:focus-visible { outline: 2px solid var(--ayt-focus); outline-offset: 1px; }
.ayt-seg__opt.is-selected { background: var(--ayt-bg-solid); color: var(--ayt-text); box-shadow: 0 1px 4px rgba(0,0,0,.25); }
.ayt-root[data-theme="light"] .ayt-seg__opt.is-selected, :host([data-theme="light"]) .ayt-seg__opt.is-selected { background: #fff; }

/* radio list */
.ayt-radio-list { display: flex; flex-direction: column; gap: 2px; }
.ayt-radio {
  display: flex; align-items: center; gap: 12px;
  padding: 9px 10px; border-radius: var(--ayt-radius-sm);
  cursor: pointer; user-select: none;
  transition: background .15s;
}
.ayt-radio:hover { background: var(--ayt-surface); }
.ayt-radio input { position: absolute; opacity: 0; pointer-events: none; }
.ayt-radio__dot {
  width: 20px; height: 20px; border-radius: 50%; flex: none;
  border: 2px solid var(--ayt-text-3);
  display: grid; place-items: center;
  transition: border-color .15s;
}
.ayt-radio__dot::after { content: ""; width: 10px; height: 10px; border-radius: 50%; background: var(--ayt-accent); transform: scale(0); transition: transform .18s var(--ayt-ease); }
.ayt-radio.is-selected .ayt-radio__dot { border-color: var(--ayt-accent); }
.ayt-radio.is-selected .ayt-radio__dot::after { transform: scale(1); }
.ayt-radio input:focus-visible + .ayt-radio__dot { outline: 2px solid var(--ayt-focus); outline-offset: 2px; }
.ayt-radio__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ayt-radio__label { font: 500 14px/1.25 var(--ayt-font); }
.ayt-radio__desc { font: 400 12px/1.3 var(--ayt-font); color: var(--ayt-text-3); }

/* switch */
.ayt-switch { display: flex; align-items: center; gap: 12px; cursor: pointer; user-select: none; padding: 6px 0; }
.ayt-switch input { position: absolute; opacity: 0; pointer-events: none; }
.ayt-switch__track {
  position: relative; width: 38px; height: 22px; border-radius: 999px; flex: none;
  background: var(--ayt-surface-hover); border: 1px solid var(--ayt-border-strong);
  transition: background .2s var(--ayt-ease), border-color .2s;
}
.ayt-switch__track::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.4);
  transition: transform .2s var(--ayt-ease);
}
.ayt-switch input:checked + .ayt-switch__track { background: var(--ayt-accent); border-color: var(--ayt-accent); }
.ayt-switch input:checked + .ayt-switch__track::after { transform: translateX(16px); }
.ayt-switch input:focus-visible + .ayt-switch__track { outline: 2px solid var(--ayt-focus); outline-offset: 2px; }
.ayt-switch__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ayt-switch__label { font: 400 14px/1.3 var(--ayt-font); color: var(--ayt-text); }
.ayt-switch__desc { font: 400 12px/1.35 var(--ayt-font); color: var(--ayt-text-3); }
.ayt-switch.is-disabled { opacity: .5; pointer-events: none; }

/* sliders (single + dual) */
.ayt-slider { display: flex; align-items: center; gap: 12px; }
.ayt-slider__value { min-width: 54px; text-align: right; font: 500 13px/1 var(--ayt-font); font-variant-numeric: tabular-nums; color: var(--ayt-text); }
.ayt-range-input {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 22px; margin: 0; background: transparent; cursor: pointer;
  --pct: 0%;
}
.ayt-range-input::-webkit-slider-runnable-track {
  height: 5px; border-radius: 999px;
  background: linear-gradient(to right, var(--ayt-accent) 0, var(--ayt-accent) var(--pct), var(--ayt-surface-hover) var(--pct));
}
.ayt-range-input::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 18px; height: 18px; margin-top: -6.5px; border-radius: 50%;
  background: #fff; border: 0; box-shadow: 0 1px 4px rgba(0,0,0,.45), 0 0 0 4px var(--ayt-accent-soft);
  transition: transform .12s var(--ayt-ease);
}
.ayt-range-input:active::-webkit-slider-thumb { transform: scale(1.15); }
.ayt-range-input:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px var(--ayt-focus); }

.ayt-dual { position: relative; height: 26px; --a: 0%; --b: 100%; }
.ayt-dual__track { position: absolute; left: 0; right: 0; top: 50%; height: 5px; transform: translateY(-50%); border-radius: 999px; background: var(--ayt-surface-hover); }
.ayt-dual__fill { position: absolute; top: 50%; height: 5px; transform: translateY(-50%); left: var(--a); right: calc(100% - var(--b)); border-radius: 999px; background: linear-gradient(90deg, var(--ayt-accent-2), var(--ayt-accent)); }
.ayt-dual input {
  -webkit-appearance: none; appearance: none;
  position: absolute; inset: 0; width: 100%; height: 100%; margin: 0;
  background: transparent; pointer-events: none;
}
.ayt-dual input::-webkit-slider-runnable-track { background: transparent; height: 5px; }
.ayt-dual input::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; pointer-events: auto; cursor: grab;
  width: 20px; height: 20px; margin-top: -7.5px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 5px rgba(0,0,0,.5), 0 0 0 4px var(--ayt-accent-soft);
}
.ayt-dual input:active::-webkit-slider-thumb { cursor: grabbing; transform: scale(1.12); }
.ayt-dual input:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px var(--ayt-focus); }
.ayt-dual__labels { display: flex; justify-content: space-between; font: 500 12px/1 var(--ayt-font); color: var(--ayt-text-2); font-variant-numeric: tabular-nums; margin-top: 4px; }

/* progress */
.ayt-progress { position: relative; height: 6px; border-radius: 999px; background: var(--ayt-surface-hover); overflow: hidden; }
.ayt-progress__bar { position: absolute; inset: 0 auto 0 0; width: 0%; border-radius: inherit; background: linear-gradient(90deg, var(--ayt-accent-2), var(--ayt-accent)); transition: width .35s var(--ayt-ease); }
.ayt-progress.is-indeterminate .ayt-progress__bar { width: 35%; animation: ayt-indet 1.15s infinite var(--ayt-ease); }
.ayt-progress.is-done .ayt-progress__bar { background: var(--ayt-success); }
.ayt-progress.is-warn .ayt-progress__bar { background: var(--ayt-warning); }
.ayt-progress.is-error .ayt-progress__bar { background: var(--ayt-danger); }
@keyframes ayt-indet { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }

/* badges */
.ayt-badge {
  display: inline-flex; align-items: center; justify-content: center;
  height: 20px; padding: 0 7px; border-radius: 6px;
  font: 700 11px/1 var(--ayt-font); letter-spacing: .3px; text-transform: uppercase;
  color: var(--ayt-badge-text); background: var(--ayt-badge-bg); white-space: nowrap;
}
.ayt-badge--accent { color: #fff; background: var(--ayt-accent-fill); }
.ayt-badge--hdr { color: #1b1300; background: linear-gradient(135deg, #ffe08a, #ffb020); }
.ayt-badge--ok { color: #fff; background: var(--ayt-success-fill); }
.ayt-badge--soft { color: var(--ayt-accent-text); background: var(--ayt-accent-soft); }

/* notices */
.ayt-notice {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 11px 12px; border-radius: var(--ayt-radius-sm);
  background: var(--ayt-surface); border: 1px solid var(--ayt-border);
  font: 400 13px/1.45 var(--ayt-font); color: var(--ayt-text);
}
.ayt-notice > .ayt-icon { margin-top: 1px; }
.ayt-notice--info > .ayt-icon { color: var(--ayt-info); }
.ayt-notice--warn { border-color: rgba(245, 158, 11, .35); background: rgba(245, 158, 11, .08); }
.ayt-notice--warn > .ayt-icon { color: var(--ayt-warning); }
.ayt-notice--error { border-color: rgba(239, 68, 68, .4); background: rgba(239, 68, 68, .09); }
.ayt-notice--error > .ayt-icon { color: var(--ayt-danger); }
.ayt-notice--success { border-color: rgba(34, 197, 94, .35); background: rgba(34, 197, 94, .08); }
.ayt-notice--success > .ayt-icon { color: var(--ayt-success); }
.ayt-notice__body { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1; }
.ayt-notice__title { font-weight: 600; }
.ayt-notice__actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }

/* spinner */
.ayt-spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--ayt-surface-hover); border-top-color: var(--ayt-accent); animation: ayt-spin .8s linear infinite; flex: none; }
@keyframes ayt-spin { to { transform: rotate(360deg); } }

/* ---------------------------------------------------------------- panel (dropdown) */
.ayt-panel {
  position: absolute; z-index: 10;
  width: min(var(--ayt-panel-w, 440px), calc(100vw - 24px));
  max-height: min(var(--ayt-panel-h, 640px), calc(100vh - 140px));
  display: flex; flex-direction: column;
  border-radius: var(--ayt-radius);
  background: var(--ayt-bg);
  border: 1px solid var(--ayt-border);
  box-shadow: var(--ayt-shadow);
  /* opaque, no backdrop-filter: a blur behind the panel is recomputed for every frame of the video under it */
  color: var(--ayt-text);
  font: 400 14px/1.4 var(--ayt-font);
  overflow: hidden;
  transform-origin: top left;
  animation: ayt-pop .18s var(--ayt-ease);
}
@keyframes ayt-pop { from { opacity: 0; transform: translateY(-6px) scale(.98); } to { opacity: 1; transform: none; } }
.ayt-panel__header { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; }
.ayt-panel__title { font: 600 15px/1.2 var(--ayt-font); flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
.ayt-panel__title::after { content: ""; flex: 1; height: 1px; background: var(--ayt-border); min-width: 16px; }
.ayt-panel__body { padding: 4px 16px 16px; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 14px; scrollbar-width: thin; scrollbar-color: var(--ayt-surface-hover) transparent; }
.ayt-panel__footer { padding: 12px 16px; border-top: 1px solid var(--ayt-border); display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
.ayt-panel__close { color: var(--ayt-text-2); }

/* list rows (format list) */
.ayt-list { display: flex; flex-direction: column; gap: 4px; }
.ayt-row {
  all: unset; box-sizing: border-box;
  position: relative;
  display: grid; grid-template-columns: 64px 74px 1fr auto; align-items: center; gap: 8px;
  min-height: 44px; padding: 8px 12px;
  border-radius: 12px; border: 1px solid transparent;
  font: 500 14px/1.2 var(--ayt-font); color: var(--ayt-text);
  cursor: pointer; user-select: none;
  transition: background .15s, border-color .2s, box-shadow .25s;
}
.ayt-row:hover { background: var(--ayt-surface); }
.ayt-row:focus-visible { outline: 2px solid var(--ayt-focus); outline-offset: 1px; }
.ayt-row.is-selected, .ayt-row.is-busy {
  background: var(--ayt-surface-2);
  border-color: var(--ayt-accent);
  box-shadow: 0 0 0 1px var(--ayt-accent), 0 0 18px var(--ayt-accent-glow), inset 0 0 12px rgba(255, 45, 70, .12);
}
.ayt-row.is-disabled { opacity: .45; cursor: not-allowed; }
.ayt-row__ext { color: var(--ayt-text-2); font-weight: 500; }
.ayt-row__res { font-weight: 600; font-variant-numeric: tabular-nums; }
.ayt-row__badges { display: flex; gap: 5px; flex-wrap: wrap; min-width: 0; }
.ayt-row__size { color: var(--ayt-text-2); font-weight: 500; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.ayt-row__progress { position: absolute; left: 12px; right: 12px; bottom: 4px; height: 3px; }

/* group heading inside panels */
.ayt-group-title { display: flex; align-items: center; gap: 8px; font: 600 12px/1 var(--ayt-font); text-transform: uppercase; letter-spacing: .6px; color: var(--ayt-text-3); margin: 4px 2px 2px; }

/* jobs */
.ayt-jobs { display: flex; flex-direction: column; gap: 8px; }
.ayt-job { display: flex; flex-direction: column; gap: 7px; padding: 10px 12px; border-radius: 12px; background: var(--ayt-surface); border: 1px solid var(--ayt-border); }
.ayt-job__top { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ayt-job__title { font: 500 13px/1.3 var(--ayt-font); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ayt-job__meta { display: flex; gap: 10px; font: 400 12px/1.2 var(--ayt-font); color: var(--ayt-text-2); font-variant-numeric: tabular-nums; flex-wrap: wrap; }
.ayt-job__meta .is-error { color: var(--ayt-danger); }
.ayt-job__meta .is-done { color: var(--ayt-success); }
.ayt-job__meta .is-warn { color: var(--ayt-warning-text); }
.ayt-job__actions { display: flex; gap: 4px; flex: none; }
.ayt-job__error { font: 400 12px/1.4 var(--ayt-font); color: var(--ayt-danger); word-break: break-word; }

/* toast: bottom-right, clear of the toolbar and panels under the video and of YouTube's own bottom-left snackbar */
.ayt-toasts { position: fixed; z-index: 2147483000; left: 0; right: 0; bottom: 24px; padding: 0 24px; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; pointer-events: none; }
.ayt-toast {
  pointer-events: auto;
  display: flex; align-items: center; gap: 10px;
  max-width: min(560px, calc(100vw - 32px));
  padding: 10px 12px 10px 14px; border-radius: 14px;
  background: var(--ayt-bg); color: var(--ayt-text);
  border: 1px solid var(--ayt-border); box-shadow: var(--ayt-shadow);
  font: 500 14px/1.35 var(--ayt-font);
  animation: ayt-toast-in .25s var(--ayt-ease);
}
.ayt-toast.is-leaving { animation: ayt-toast-out .2s var(--ayt-ease) forwards; }
.ayt-toast--success > .ayt-icon:first-child { color: var(--ayt-success); }
.ayt-toast--error > .ayt-icon:first-child { color: var(--ayt-danger); }
.ayt-toast--warn > .ayt-icon:first-child { color: var(--ayt-warning); }
.ayt-toast--info > .ayt-icon:first-child { color: var(--ayt-info); }
.ayt-toast__text { flex: 1; min-width: 0; }
@keyframes ayt-toast-in { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes ayt-toast-out { to { opacity: 0; transform: translateY(6px) scale(.98); } }

/* tooltip (toolbar) */
.ayt-tip {
  position: absolute; z-index: 20; pointer-events: none;
  padding: 7px 10px; border-radius: 8px;
  background: rgba(40, 40, 46, .96); color: #fff;
  font: 500 12px/1.2 var(--ayt-font); white-space: nowrap;
  box-shadow: 0 6px 16px rgba(0,0,0,.35);
  opacity: 0; transform: translateY(4px); transition: opacity .12s, transform .12s;
}
.ayt-tip.is-visible { opacity: 1; transform: none; }
.ayt-root[data-theme="light"] .ayt-tip, :host([data-theme="light"]) .ayt-tip { background: rgba(28, 28, 32, .92); }

/* toolbar */
.ayt-toolbar { position: relative; display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 6px 0 4px; font-family: var(--ayt-font); }
.ayt-tb-btn {
  all: unset; box-sizing: border-box; position: relative;
  width: 40px; height: 40px; border-radius: 50%;
  display: inline-grid; place-items: center;
  color: var(--ayt-text); cursor: pointer;
  transition: background .15s var(--ayt-ease), color .15s, box-shadow .2s, transform .1s;
}
.ayt-tb-btn:hover { background: var(--ayt-tb-hover); }
.ayt-tb-btn:active { transform: scale(.94); }
.ayt-tb-btn:focus-visible { box-shadow: 0 0 0 2px var(--ayt-focus); }
.ayt-tb-btn.is-open { background: var(--ayt-tb-active); }
.ayt-tb-btn.is-on { color: var(--ayt-accent); background: var(--ayt-accent-soft); }
.ayt-tb-btn.is-flash { box-shadow: 0 0 0 2px var(--ayt-accent), 0 0 16px var(--ayt-accent-glow); }
/* badge on the button's top-right corner, outside the 22 px icon so "1.5" or "0.25" does not hide it */
.ayt-tb-btn__dot {
  position: absolute; top: -2px; right: -6px; z-index: 1; min-width: 16px; height: 16px; padding: 0 4px;
  border-radius: 999px; background: var(--ayt-accent-3); color: #fff;
  font: 700 10px/16px var(--ayt-font); text-align: center; box-shadow: 0 0 0 2px var(--ayt-bg-solid);
}
.ayt-tb-btn__ring { position: absolute; inset: 2px; border-radius: 50%; pointer-events: none;
  background: conic-gradient(var(--ayt-accent) calc(var(--p, 0) * 1%), transparent 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px));
          mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px)); }
.ayt-tb-sep { width: 1px; height: 22px; margin: 0 6px; background: var(--ayt-border-strong); }
.ayt-tb-brand { display: inline-flex; align-items: center; margin-right: 4px; opacity: .9; }

/* generic key/value grid */
.ayt-kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font: 400 13px/1.4 var(--ayt-font); }
.ayt-kv dt { color: var(--ayt-text-2); }
.ayt-kv dd { margin: 0; }

/* scrollbars inside our UI */
.ayt-root ::-webkit-scrollbar, :host ::-webkit-scrollbar { width: 10px; height: 10px; }
.ayt-root ::-webkit-scrollbar-thumb, :host ::-webkit-scrollbar-thumb { background: var(--ayt-surface-hover); border-radius: 999px; border: 3px solid transparent; background-clip: content-box; }

@media (prefers-reduced-motion: reduce) {
  .ayt-root *, :host * { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}
`;
})(globalThis);
