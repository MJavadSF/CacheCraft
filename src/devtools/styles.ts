export const STYLES = `
:host { all: initial; }
.cc-root {
  --bg: #ffffff; --bg2: #f5f6f8; --fg: #1d2129; --muted: #6b7280; --line: #e3e5ea;
  --accent: #4f46e5; --accent-fg: #ffffff; --danger: #dc2626; --ok: #16a34a; --warn: #d97706;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font: 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--fg);
  position: fixed; z-index: 2147483000;
}
@media (prefers-color-scheme: dark) {
  .cc-theme-auto { --bg: #16181d; --bg2: #1f2229; --fg: #e6e8ec; --muted: #9aa1ad; --line: #2c3039; --accent: #818cf8; --accent-fg: #0b0c10; }
}
.cc-theme-dark { --bg: #16181d; --bg2: #1f2229; --fg: #e6e8ec; --muted: #9aa1ad; --line: #2c3039; --accent: #818cf8; --accent-fg: #0b0c10; }
.cc-bottom-right { right: 12px; bottom: 12px; }
.cc-bottom-left { left: 12px; bottom: 12px; }
.cc-top-right { right: 12px; top: 12px; }
.cc-top-left { left: 12px; top: 12px; }
.cc-toggle {
  border: 0; border-radius: 999px; padding: 7px 12px; cursor: pointer;
  background: var(--accent); color: var(--accent-fg); font: 600 12px system-ui, sans-serif;
  box-shadow: 0 4px 14px rgba(0,0,0,.25);
}
.cc-panel {
  position: fixed; left: 0; right: 0; bottom: 0; height: 45vh; min-height: 160px;
  background: var(--bg); border-top: 1px solid var(--line);
  box-shadow: 0 -8px 30px rgba(0,0,0,.18); display: flex; flex-direction: column;
}
.cc-resizer { height: 5px; cursor: ns-resize; background: transparent; flex: none; }
.cc-resizer:hover { background: var(--accent); }
.cc-header { display: flex; align-items: center; gap: 8px; padding: 4px 10px 6px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.cc-title { font-weight: 700; }
.cc-tabs { display: flex; gap: 2px; }
.cc-tab { background: none; border: 0; padding: 5px 10px; border-radius: 6px; color: var(--muted); cursor: pointer; font: inherit; }
.cc-tab:hover { background: var(--bg2); color: var(--fg); }
.cc-tab.cc-active { background: var(--bg2); color: var(--fg); font-weight: 600; }
.cc-spacer { flex: 1; }
.cc-message { color: var(--accent); font-weight: 600; max-width: 40ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-view { padding: 10px; overflow: auto; flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.cc-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.cc-card { background: var(--bg2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
.cc-card-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.cc-card-value { font-size: 16px; font-weight: 700; margin-top: 2px; word-break: break-all; }
.cc-card-hint { color: var(--muted); font-size: 11px; margin-top: 2px; }
.cc-health { border-radius: 8px; padding: 8px 10px; border: 1px solid var(--line); }
.cc-health.cc-ok strong { color: var(--ok); }
.cc-health.cc-warn strong { color: var(--warn); }
.cc-actions, .cc-toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.cc-btn {
  font: inherit; border: 1px solid var(--line); background: var(--bg2); color: var(--fg);
  border-radius: 6px; padding: 4px 10px; cursor: pointer; display: inline-flex; align-items: center;
}
.cc-btn:hover { border-color: var(--accent); }
.cc-icon { padding: 3px 8px; }
.cc-danger { color: var(--danger); }
.cc-danger.cc-armed { background: var(--danger); color: #fff; border-color: var(--danger); }
.cc-hidden { display: none; }
.cc-input, .cc-select {
  font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line);
  border-radius: 6px; padding: 4px 8px;
}
.cc-input { min-width: 220px; }
.cc-input.cc-small { min-width: 90px; width: 90px; }
.cc-check { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); }
.cc-pager { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; color: var(--muted); }
.cc-split { display: grid; grid-template-columns: minmax(0, 3fr) minmax(260px, 2fr); gap: 10px; flex: 1; min-height: 0; }
.cc-table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
.cc-table { width: 100%; border-collapse: collapse; }
.cc-table th { position: sticky; top: 0; background: var(--bg2); text-align: left; font-weight: 600; color: var(--muted); }
.cc-table th, .cc-table td { padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.cc-table tbody tr { cursor: pointer; }
.cc-table tbody tr:hover { background: var(--bg2); }
.cc-table tr.cc-selected { background: color-mix(in srgb, var(--accent) 15%, transparent); }
.cc-table tr.cc-expired td { opacity: .55; }
.cc-key { font-family: var(--mono); max-width: 360px; overflow: hidden; text-overflow: ellipsis; }
.cc-flags { letter-spacing: 2px; }
.cc-detail { border: 1px solid var(--line); border-radius: 8px; padding: 8px; overflow: auto; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.cc-detail-key { font-family: var(--mono); font-weight: 700; word-break: break-all; }
.cc-meta { margin: 0; font: 11px/1.4 var(--mono); color: var(--muted); max-height: 120px; overflow: auto; background: var(--bg2); padding: 6px; border-radius: 6px; }
.cc-editor { font: 12px/1.45 var(--mono); color: var(--fg); background: var(--bg2); border: 1px solid var(--line); border-radius: 6px; padding: 6px; min-height: 140px; flex: 1; resize: vertical; }
.cc-muted { color: var(--muted); }
.cc-error { color: var(--danger); }
.cc-log { font: 11px/1.5 var(--mono); border: 1px solid var(--line); border-radius: 8px; overflow: auto; flex: 1; }
.cc-log-row { display: grid; grid-template-columns: 90px 60px minmax(0, 1fr) auto; gap: 8px; padding: 2px 8px; border-bottom: 1px solid var(--line); }
.cc-log-row .cc-key { max-width: none; }
.cc-ev { font-weight: 700; }
.cc-ev-hit .cc-ev, .cc-ev-set .cc-ev { color: var(--ok); }
.cc-ev-miss .cc-ev, .cc-ev-expire .cc-ev { color: var(--warn); }
.cc-ev-delete .cc-ev, .cc-ev-evict .cc-ev, .cc-ev-clear .cc-ev, .cc-ev-error .cc-ev { color: var(--danger); }
.cc-bar { height: 8px; background: var(--bg2); border-radius: 999px; overflow: hidden; border: 1px solid var(--line); }
.cc-bar-fill { height: 100%; background: var(--accent); }
@media (max-width: 720px) { .cc-split { grid-template-columns: 1fr; } }
`;
