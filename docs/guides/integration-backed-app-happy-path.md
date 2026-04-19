# Integration-backed app happy path

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
4. If the smoke test passes, proceed directly to building the app.
   - Prefer a saved app with `serverCode` backend endpoints such as `/api/state`
     and `/api/action`.
   - Keep `clientCode` mostly UI plus `kodyWidget.appBackend.fetch(...)` calls.
5. Open the saved app and iterate.
   - Save with `ui_save_app`.
   - Reopen with `open_generated_ui({ app_id })`.
   - Iterate on the hosted app instead of repeatedly pasting large inline HTML
     blobs back into the model context.

## Default saved app shape

For non-trivial or integration-backed apps, prefer this split:

- `serverCode`: connector lookups, provider API calls, persistence, validation,
  and mutations
- `clientCode`: rendering, form handling, button clicks, and fetches to the app
  backend
- `executeCode(...)` embedded directly in client HTML: acceptable for quick
  prototypes or one-off experiments, not the default saved-app pattern

## Avoid this detour

If the connector state, secret names, allowed hosts, and provider contract are
already clear enough, do **not** spend extra time spelunking the local repo
before building the app.

Inspect local source only when you specifically need repo conventions, shared
helpers, or an existing app artifact to extend.
