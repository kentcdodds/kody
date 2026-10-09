# kody API edge worker

Public edge for the Kody Open API at `https://api.kody.codes`. It serves JSON
only:

- `GET /health` returns `{ ok, commit }` and is answered at the edge.
- `GET /openapi.json` returns the OpenAPI 3.1 document.
- `/v1/*` serves the versioned operations, including tokens and the
  CapabilityProxy.

The edge applies CORS (bearer-only, no cookies), per-IP and per-token rate
limits, a 5 MiB body cap, and header stripping (`Cookie` and `X-Kody-*` never
reach origin). It then forwards to the origin `KodyApi` entrypoint over the
`KODY_API` service binding. Authentication, scopes, feature flags, and the
operations themselves live in `packages/worker/src/open-api/`.

- `wrangler.jsonc` is the committed config. The production script is `kody-api`
  on the `api.kody.codes` custom domain, and previews deploy as
  `kody-pr-<n>-api`.
- Build check: `npm run api:build` (part of `npm run validate`).
- Deploys and previews: see `.github/workflows/deploy.yml` and `preview.yml`.
- Contracts: `docs/contributing/architecture/open-api.md`.
