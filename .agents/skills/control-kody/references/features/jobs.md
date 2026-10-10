# Jobs

Package-owned schedules and their run history.

## How to get there

`/@<slug>/-/jobs` and `/@<slug>/-/jobs/:jobId`. `/account/jobs` redirects there.
JSON stays at `/account/jobs.json`.

## Drive it

```bash
node tools/control-kody.ts request GET /account/jobs.json
```

Preview seed has no jobs until a package with `kody.jobs` exists.

## APIs

- `GET|POST /account/jobs.json`

## Gotchas

- Republishing `"enabled": false` does not disable a running job. Use
  `jobUpdate` or the package pause export.
