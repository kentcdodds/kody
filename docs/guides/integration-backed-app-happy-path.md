# Integration-backed package app happy path

Use this guide after `integration_bootstrap` proves the integration already
works, or when connector and secret state are already clear enough to verify
quickly.

## Recommended sequence

1. Discover connector and secret state.
   - Use `search` to inspect saved connectors and secret references.
   - Read full connector metadata only when you need the exact names, hosts, or
     API base URL.
2. Verify the required connector exists.
   - Confirm the connector name, token secret names, and API base URL match the
     app you are about to build.
3. Run one cheap authenticated smoke test in `execute`.
   - Prefer a small read-only request such as `GET /me`, `GET /viewer`, or
     `GET /v1/me`.
4. If the smoke test passes, proceed directly to building the package app.
   - Prefer a saved package with `package.json#kody.app.entry`.
   - Keep provider API calls and durable coordination in package-owned backend
     modules or internal Worker/DO implementation details.
5. Open the hosted package app and iterate.
   - Save with `package_save`.
   - Reopen with `open_generated_ui({ package_id })` or the hosted package URL.
   - Iterate on the hosted package app instead of repeatedly pasting large
     inline HTML blobs back into model context.

## Default package app shape

For non-trivial or integration-backed package apps, prefer this split:

- package app entry: Worker-style fetch surface declared by
  `package.json#kody.app.entry`
- package exports: reusable modules and callable default exports declared in
  `package.json.exports`
- internal backend modules / Durable Objects / facets: connector lookups,
  provider API calls, persistence, validation, and mutations
- inline HTML/code renders: acceptable for quick prototypes or one-off
  experiments, not the default package app pattern

## Avoid this detour

If the connector state, secret names, allowed hosts, and provider contract are
already clear enough, do **not** spend extra time spelunking the local repo
before building the app.

Inspect local source only when you specifically need repo conventions, shared
helpers, or an existing package to extend.
