# kody API docs worker

Interactive OpenAPI docs at `https://api-docs.kody.codes`. The page loads the
live OpenAPI 3.1 document from `https://api.kody.codes/openapi.json` (also
proxied at `/openapi.json` on this host) and renders it with
[Scalar](https://github.com/scalar/scalar).

This worker is HTML-only. The API edge (`kody-api`) stays JSON-only and never
negotiates `Accept: text/html`.

- Production script: `kody-api-docs` on the `api-docs.kody.codes` custom domain
  (`custom_domain: true` creates DNS + cert on deploy).
- Build check: `npm run api-docs:build` (part of `npm run validate`).
- Deploy: `.github/workflows/deploy.yml` job `deploy-api-docs-worker`.
- Contracts: `docs/contributing/architecture/open-api.md`.
