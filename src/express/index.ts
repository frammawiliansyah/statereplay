import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { StateReplay } from "../index.js";

/**
 * StateReplay Express integration.
 *
 * `express` is an OPTIONAL peer dependency — it is imported here for types only
 * (erased at build), so this module adds no runtime dependency. The middleware
 * reads the live cache exclusively through the public API.
 *
 * ⚠️ Development/staging only, or place it behind authentication: the endpoints
 * expose your workflow state. They never expose the `secretKey`, the raw log
 * file, or the lock file.
 */

export interface StateReplayMiddlewareOptions {
  /** Mount prefix for the endpoints. Default: "/_statereplay". */
  basePath?: string;
  /** Serve the inlined dashboard at `{basePath}/dashboard`. Default: true. */
  enableDashboard?: boolean;
}

function normalizeBasePath(basePath: string): string {
  return basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
}

/**
 * Build an Express middleware exposing read-only StateReplay endpoints:
 *
 * - `GET {basePath}/health`      → `getStats()` + `{ ok, ready }`
 * - `GET {basePath}/states`      → `{ states: Record<id, StatePayload> }`
 * - `GET {basePath}/states/:id`  → `{ id, state }` or 404
 * - `GET {basePath}/dashboard`   → inlined HTML (when `enableDashboard`)
 */
export function createStateReplayMiddleware<TData = Record<string, unknown>>(
  replay: StateReplay<TData>,
  options: StateReplayMiddlewareOptions = {},
): RequestHandler {
  const basePath = normalizeBasePath(options.basePath ?? "/_statereplay");
  const enableDashboard = options.enableDashboard ?? true;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" || !req.path.startsWith(basePath)) {
      next();
      return;
    }
    const sub = req.path.slice(basePath.length) || "/";

    if (sub === "/health") {
      res.json({ ...replay.getStats(), ok: true, ready: replay.ready });
      return;
    }
    if (sub === "/states") {
      res.json({ states: Object.fromEntries(replay.getAllStates()) });
      return;
    }
    if (sub.startsWith("/states/")) {
      const id = decodeURIComponent(sub.slice("/states/".length));
      const state = replay.getState(id);
      if (state === undefined) {
        res.status(404).json({ id, error: "not found" });
        return;
      }
      res.json({ id, state });
      return;
    }
    if (sub === "/dashboard") {
      if (!enableDashboard) {
        res.status(404).json({ error: "dashboard disabled" });
        return;
      }
      res.type("html").send(DASHBOARD_HTML);
      return;
    }
    next();
  };
}

/**
 * The dashboard, inlined as a string constant (NOT a shipped `.html` asset —
 * tsup/tsc do not copy `.html` into `dist/`, which would break `./express` at
 * runtime). Client JS fetches `states` *relative* to its own URL, so it follows
 * a custom `basePath` automatically, and HTML-escapes all values to avoid XSS.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>StateReplay Dashboard</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
  .meta { color: #666; font-size: 0.85rem; margin-bottom: 1rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #fafafa; position: sticky; top: 0; }
  td.status { font-weight: 600; }
  td.PENDING { color: #b58900; }
  td.PROCESSING { color: #268bd2; }
  td.SUCCESS, td.COMPLETED { color: #2aa198; }
  td.FAILED { color: #dc322f; }
  select { padding: 0.2rem; }
  code { color: #999; }
</style>
</head>
<body>
<h1>StateReplay</h1>
<div class="meta">
  Filter:
  <select id="filter">
    <option value="">all</option>
    <option>PENDING</option><option>PROCESSING</option><option>SUCCESS</option>
    <option>FAILED</option><option>COMPLETED</option>
  </select>
  <span id="count"></span> &middot; <code>refreshing every 5s</code>
</div>
<table>
  <thead><tr><th>id</th><th>step</th><th>status</th><th>timestamp</th><th>error</th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<script>
  var filterEl = document.getElementById("filter");
  var rowsEl = document.getElementById("rows");
  var countEl = document.getElementById("count");
  var ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) { return ENT[c]; });
  }
  function render(states) {
    var filter = filterEl.value;
    var ids = Object.keys(states).sort();
    var html = "";
    var shown = 0;
    for (var i = 0; i < ids.length; i++) {
      var s = states[ids[i]];
      if (filter && s.status !== filter) continue;
      shown++;
      var ts = s.timestamp ? new Date(s.timestamp).toISOString() : "";
      html += "<tr><td>" + esc(ids[i]) + "</td><td>" + esc(s.step) + "</td>" +
        '<td class="status ' + esc(s.status) + '">' + esc(s.status) + "</td>" +
        "<td>" + esc(ts) + "</td><td>" + esc(s.error) + "</td></tr>";
    }
    rowsEl.innerHTML = html;
    countEl.textContent = shown + " of " + ids.length + " ids";
  }
  function refresh() {
    fetch("states")
      .then(function (r) { return r.json(); })
      .then(function (d) { render(d.states || {}); })
      .catch(function () {});
  }
  filterEl.addEventListener("change", refresh);
  refresh();
  setInterval(refresh, 5000);
</script>
</body>
</html>`;
