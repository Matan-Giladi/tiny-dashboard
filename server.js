'use strict';

// tiny-dashboard — a minimal internal local dashboard.
//   GET    /                      HTML list of services; filter + sort via htmx
//   GET    /partials/services     HTML table fragment swapped in by htmx
//   GET    /vendor/htmx.min.js    htmx, served from node_modules
//   GET    /api/services          JSON list   (?q=&status=&sort=&order=)
//   POST   /api/services          create      {name, owner, status}
//   GET    /api/services/:id      one service
//   PUT    /api/services/:id      replace     {name, owner, status}
//   DELETE /api/services/:id      remove

const http = require('http');
const fs = require('fs');
const path = require('path');
const pinoHttp = require('pino-http');
const logger = require('./lib/logger');
const store = require('./lib/store');
const { STATUSES, ValidationError } = require('./lib/schema');

const PORT = process.env.PORT || 3000;
const HTMX_FILE = path.join(__dirname, 'node_modules', 'htmx.org', 'dist', 'htmx.min.js');
const MAX_BODY_BYTES = 64 * 1024;
const SORT_COLUMNS = ['name', 'owner', 'status'];

const STATUS_LABEL = {
  healthy: '🟢 healthy',
  degraded: '🟡 degraded',
  maintenance: '🔧 maintenance'
};

const httpLogger = pinoHttp({
  logger,
  customLogLevel(req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  }
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- rendering ----------

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="htmx-config" content='{"allowEval":false,"includeIndicatorStyles":false}'>
  <title>${esc(title)}</title>
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 720px; color: #1a1a1a; padding: 0 1rem; }
    h1 { font-size: 1.4rem; } a { color: #2563eb; text-decoration: none; } a:hover { text-decoration: underline; }
    table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #eee; }
    th a { color: inherit; } th a.active { color: #2563eb; }
    form.filters { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
    input, select { font: inherit; padding: .35rem .5rem; border: 1px solid #ccc; border-radius: 4px; }
    .empty { color: #666; font-style: italic; }
    .hint { color: #666; font-size: .85rem; }
  </style>
</head>
<body>${body}
<script src="/vendor/htmx.min.js"></script>
</body>
</html>`;
}

function sortLink(params, column, label) {
  const active = params.sort === column;
  const nextOrder = active && params.order === 'asc' ? 'desc' : 'asc';
  const arrow = active ? (params.order === 'asc' ? ' ▲' : ' ▼') : '';
  const href = '/?' + new URLSearchParams({ q: params.q, status: params.status, sort: column, order: nextOrder });
  // column/nextOrder come from fixed whitelists, so the JSON is safe inside the attribute.
  return `<a href="${href}" class="${active ? 'active' : ''}"
    hx-get="/partials/services" hx-vals='${JSON.stringify({ sort: column, order: nextOrder })}'
    hx-include="#filters" hx-target="#services" hx-swap="outerHTML">${label}${arrow}</a>`;
}

// The fragment htmx swaps in. It carries the current sort as hidden inputs so
// the filter form (hx-include="#services") preserves it on the next request.
function renderTable(services, params) {
  const rows = services.map((s) => `
      <tr>
        <td>${esc(s.name)}</td>
        <td>${esc(s.owner)}</td>
        <td>${STATUS_LABEL[s.status] || esc(s.status)}</td>
      </tr>`).join('');
  const body = rows || `<tr><td colspan="3" class="empty">No services match.</td></tr>`;
  return `<div id="services">
    <input type="hidden" name="sort" value="${esc(params.sort)}">
    <input type="hidden" name="order" value="${esc(params.order)}">
    <table>
      <thead><tr>
        <th>${sortLink(params, 'name', 'Name')}</th>
        <th>${sortLink(params, 'owner', 'Owner')}</th>
        <th>${sortLink(params, 'status', 'Status')}</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function renderIndex(params) {
  const options = ['', ...STATUSES].map((s) =>
    `<option value="${s}"${s === params.status ? ' selected' : ''}>${s || 'all statuses'}</option>`).join('');
  return page('tiny-dashboard', `
    <h1>Services</h1>
    <form id="filters" class="filters" action="/" method="get"
      hx-get="/partials/services" hx-target="#services" hx-swap="outerHTML"
      hx-trigger="input delay:300ms, submit" hx-include="#services">
      <input type="search" name="q" value="${esc(params.q)}" placeholder="Filter by name or owner" aria-label="Filter">
      <select name="status" aria-label="Status">${options}</select>
      <noscript><button type="submit">Apply</button></noscript>
    </form>
    ${renderTable(store.listServices(params), params)}
    <p class="hint">Create, edit and delete services through the JSON API (see README).</p>`);
}

// ---------- request helpers ----------

function listParams(url) {
  const get = (k) => url.searchParams.get(k) || '';
  return {
    q: get('q').trim().slice(0, 100),
    status: STATUSES.includes(get('status')) ? get('status') : '',
    sort: SORT_COLUMNS.includes(get('sort')) ? get('sort') : 'name',
    order: get('order') === 'desc' ? 'desc' : 'asc'
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return reject(new HttpError(400, 'expected a JSON body'));
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function notFound(res, pathname) {
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found' });
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found\n');
}

function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: 'method_not_allowed', allow });
}

// Security headers for every response. htmx runs inline via hx-* attributes
// with allowEval disabled, so the CSP only needs same-origin scripts and
// inline styles for the page <style> block.
function secure(req, res) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ];
  if (process.env.NODE_ENV === 'production') csp.push('upgrade-insecure-requests');
  res.setHeader('Content-Security-Policy', csp.join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
}

// ---------- routing ----------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { method } = req;
  const pathname = url.pathname;

  if (pathname === '/') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    return sendHtml(res, 200, renderIndex(listParams(url)));
  }

  if (pathname === '/partials/services') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    const params = listParams(url);
    return sendHtml(res, 200, renderTable(store.listServices(params), params));
  }

  if (pathname === '/vendor/htmx.min.js') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    return fs.createReadStream(HTMX_FILE).pipe(res);
  }

  if (pathname === '/api/services') {
    if (method === 'GET') return sendJson(res, 200, store.listServices(listParams(url)));
    if (method === 'POST') {
      const created = store.createService(await readJson(req));
      res.setHeader('Location', `/api/services/${created.id}`);
      return sendJson(res, 201, created);
    }
    return methodNotAllowed(res, 'GET, POST');
  }

  const match = pathname.match(/^\/api\/services\/(\d{1,12})$/);
  if (match) {
    const id = Number(match[1]);
    if (method === 'GET') {
      const service = store.getService(id);
      return service ? sendJson(res, 200, service) : notFound(res, pathname);
    }
    if (method === 'PUT') {
      const updated = store.updateService(id, await readJson(req));
      return updated ? sendJson(res, 200, updated) : notFound(res, pathname);
    }
    if (method === 'DELETE') {
      if (!store.deleteService(id)) return notFound(res, pathname);
      res.writeHead(204);
      return res.end();
    }
    return methodNotAllowed(res, 'GET, PUT, DELETE');
  }

  notFound(res, pathname);
}

const server = http.createServer((req, res) => {
  httpLogger(req, res);
  secure(req, res);
  handle(req, res).catch((err) => {
    if (err instanceof ValidationError) return sendJson(res, 400, { error: 'validation_failed', issues: err.issues });
    if (err instanceof store.ConflictError) return sendJson(res, 409, { error: 'conflict', message: err.message });
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    req.log.error({ err }, 'unhandled error');
    if (res.headersSent) return res.destroy();
    sendJson(res, 500, { error: 'internal_error' });
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    logger.info({ port: Number(PORT), db: process.env.DASHBOARD_DB || 'data/dashboard.db' }, 'tiny-dashboard listening');
  });
}

module.exports = server;
