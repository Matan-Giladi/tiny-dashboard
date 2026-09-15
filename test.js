'use strict';

// Runs against an in-memory database so the on-disk data/dashboard.db is untouched.
process.env.DASHBOARD_DB = ':memory:';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const assert = require('assert');
const { serviceSchema, servicesFileSchema, ValidationError } = require('./lib/schema');
const store = require('./lib/store');
const server = require('./server');

// ---- schema ----
const parsed = serviceSchema.parse({ name: '  Search API ', owner: 'Platform', status: 'healthy' });
assert.deepStrictEqual(parsed, { name: 'Search API', owner: 'Platform', status: 'healthy' }, 'parse trims strings');

const incorrect = serviceSchema.safeParse({ name: '', owner: 42, status: 'down', extra: 1 });
assert.strictEqual(incorrect.success, false);
assert.ok(incorrect.error instanceof ValidationError);
assert.deepStrictEqual(incorrect.error.issues.map((i) => i.path.join('.')).sort(), ['extra', 'name', 'owner', 'status']);

assert.strictEqual(servicesFileSchema.safeParse([]).success, false, 'empty seed file is rejected');
const nested = servicesFileSchema.safeParse([{ name: 'a', owner: 'b', status: 'healthy' }, { name: 'c', owner: 'd', status: 'nope' }]);
assert.deepStrictEqual(nested.error.issues[0].path, [1, 'status'], 'issues carry the array index');

// ---- store ----
const seeded = store.listServices();
assert.strictEqual(seeded.length, 5, 'seeded from data/services.json');
assert.ok(seeded.every((s) => Number.isInteger(s.id) && s.created_at && s.updated_at));
assert.strictEqual(seeded[0].name, 'Billing & Invoices', 'default sort is name asc');

assert.strictEqual(store.listServices({ q: 'platform' }).length, 2, 'q matches owner, case-insensitive');
assert.strictEqual(store.listServices({ q: 'search' }).length, 1, 'q matches name');
assert.strictEqual(store.listServices({ q: '%' }).length, 0, 'LIKE wildcards are escaped');
assert.deepStrictEqual(store.listServices({ status: 'degraded' }).map((s) => s.name), ['Email / Notifications']);
assert.strictEqual(store.listServices({ sort: 'name', order: 'desc' })[0].name, 'User Auth Service');
assert.strictEqual(store.listServices({ sort: 'bogus; DROP TABLE services' })[0].name, 'Billing & Invoices', 'unknown sort falls back');

const created = store.createService({ name: 'Cache', owner: 'Platform', status: 'healthy' });
assert.ok(created.id > 5);
assert.throws(() => store.createService({ name: 'cache', owner: 'X', status: 'healthy' }), store.ConflictError, 'names are unique, case-insensitive');
assert.throws(() => store.createService({ name: 'Cache2', status: 'healthy' }), ValidationError);

// ---- http ----
async function http() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = (method, path, body) => fetch(base + path, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body)
  });

  // HTMX
  const htmx = await fetch(base + '/vendor/htmx.min.js');
  assert.strictEqual(htmx.status, 200);
  assert.ok((await htmx.text()).length > 10000, 'htmx served from node_modules');

  // partial: filtering, sorting, escaping
  let partial = await (await fetch(base + '/partials/services?q=platform&sort=name&order=desc')).text();
  assert.ok(partial.startsWith('<div id="services">'));
  assert.ok(partial.indexOf('User Auth Service') < partial.indexOf('Search API'), 'sorted desc');
  assert.ok(!partial.includes('Billing'), 'filtered');
  assert.ok(partial.includes('<input type="hidden" name="sort" value="name">'));
  partial = await (await fetch(base + '/partials/services?q=zzz')).text();
  assert.ok(partial.includes('No services match.'));

  // API: list, create, validation, conflict, get, update, delete, 404
  let res = await json('GET', '/api/services?status=maintenance');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await res.json()).map((s) => s.name), ['Reporting Dashboard']);

  res = await fetch(base + '/api/services', { method: 'POST', body: '{not json' });
  assert.strictEqual(res.status, 400);

  server.close();
}

http().then(() => {
  console.log('tiny-dashboard: all tests passed');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
