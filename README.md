# tiny-dashboard

A tiny internal local dashboard. It keeps a small service catalog in SQLite,
serves it as a web page with filtering and sorting, and exposes a JSON API for
managing entries.

## Install
```bash
npm install
```

Node 22.13 or newer is required.

## Run
```bash
npm start
# → http://localhost:3000
```
Environment:

| Variable       | Default             | Meaning                                          |
|----------------|---------------------|--------------------------------------------------|
| `PORT`         | `3000`              | Listen port                                      |
| `DASHBOARD_DB` | `data/dashboard.db` | SQLite file; `:memory:` for a throwaway database |
| `LOG_LEVEL`    | `info`              | pino level: `debug`, `info`, `warn`, `error`, `silent` |
| `NODE_ENV`     |                     | `production` adds `upgrade-insecure-requests` to the CSP |

On first start the database is empty and is seeded from `data/services.json`
after that file is validated. Later edits go through the API, not the JSON file.

## Test
```bash
npm test
```
Tests run against an in-memory database.

## Routes
| Route                        | Description                                              |
|------------------------------|----------------------------------------------------------|
| `GET /`                      | HTML table of services with filter box and sortable columns (htmx) |
| `GET /partials/services`     | The table fragment htmx swaps in; same query params as the API |
| `GET /api/services`          | JSON list. Query: `q` (name/owner substring), `status`, `sort` (`name`/`owner`/`status`), `order` (`asc`/`desc`) |
| `POST /api/services`         | Create. Body: `{"name","owner","status"}` → 201 + `Location` |
| `GET /api/services/:id`      | One service                                              |
| `PUT /api/services/:id`      | Replace. Same body as create                             |
| `DELETE /api/services/:id`   | Remove → 204                                             |

`status` is one of `healthy`, `degraded`, `maintenance`. Names are unique
(case-insensitive). Validation failures return 400 with an `issues` array,
duplicates return 409.

```bash
curl -X POST localhost:3000/api/services \
  -H 'content-type: application/json' \
  -d '{"name":"Cache","owner":"Platform","status":"healthy"}'
```

## Logging
Every request is logged as one JSON line by `pino-http` (method, url, status,
response time, request id). Set `LOG_LEVEL=debug` for more, or pipe through
`pino-pretty` locally if you have it.