# Package app fetch

`package_app_fetch` invokes a published package app's fetch handler over MCP. It
is a **platform-marked real-surface** `app_fetch` run: same package runtime,
`packageStorage()`, and secret mounts as production traffic. **Side effects are
real.**

Use it to verify `kody.app` wiring and JSON/API responses immediately after
publish — without opening the hosted URL in a browser or performing session
handoff.

The platform strips caller-supplied `Kody-Synthetic` from MCP input (same as
public app ingress) and sets `Kody-Synthetic: true` before the handler runs.
Handlers treat synthetic fetches identically to production unless a deliberately
visible irreversible-side-effect guard says otherwise.

Hosted-URL checks remain useful for UI, OAuth redirects, and websocket facets.

## When to use it

- After `package_publish_external_push` when the package declares
  `package.json#kody.app`
- When `test_hints.app` is present on the publish response (copy-paste starting
  point)
- To prove a fetch handler returns expected status/body before sharing
  `hosted_app_url` with a user

Prefer `packages.invoke` for export smoke tests. Prefer
[Inbound webhooks](./webhooks.md) ingress for provider POST deliveries.

## Call shape

Search the `packages` domain, then call `package_app_fetch`:

```json
{
	"kody_id": "my-app"
}
```

Optional request fields:

| Field           | Default | Meaning                                                         |
| --------------- | ------- | --------------------------------------------------------------- |
| `package_scope` | omitted | Owner scope for delegated packages; preserve it from test hints |
| `path`          | `/`     | Path **after** the app mount (what the handler sees)            |
| `method`        | `GET`   | HTTP method                                                     |
| `headers`       | `{}`    | Extra request headers (safe subset)                             |
| `body`          | omitted | Raw request body string for `POST` / `PUT` / `PATCH`            |

Example POST with JSON:

```json
{
	"kody_id": "my-app",
	"path": "/api/items",
	"method": "POST",
	"headers": { "content-type": "application/json" },
	"body": "{\"name\":\"smoke\"}"
}
```

Pass the bare `kody.id` (for example `my-app`), not the npm-scoped package name.
When `test_hints.app` includes `package_scope`, preserve that exact owner scope
so the probe cannot resolve an unrelated same-named package in the caller's
personal scope.

Websocket upgrade requests (`Upgrade: websocket`, `Connection: Upgrade`, or
equivalent) are rejected.

## Response

The capability returns exactly:

| Field       | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `status`    | HTTP status code                                                       |
| `headers`   | Response headers (safe allowlisted subset)                             |
| `body`      | Response body text, or base64 when the handler returns binary content  |
| `truncated` | `true` when the body was truncated to fit the MCP response size budget |

Failures surface as structured MCP errors with the handler's thrown message or
non-2xx body when applicable. Check [Activity](./activity.md) (`app_fetch`
surface) for run records; the run record carries the same `Kody-Synthetic`
marker the handler saw.

## Semantics

- Resolves the signed-in user's saved package at its current published commit.
- Strips credential headers (`Cookie`, `Authorization`, and internal `X-Kody-*`
  headers) before the handler runs — same rule as public package-app ingress.
- Populates `packageContext` (`hostedUrl`, `appBasePath`) from the serving
  username and `kody.id`.
- Does **not** count toward package activation milestones.

## Related

- [Packages](./packages.md) — package apps and `hosted_app_url`
- [Synthetic event dispatch](./synthetic-event-dispatch.md) — subscription
  handler smoke tests
- [Package authoring guide](../guides/package-authoring.md#verify-your-publish)
- Decision:
  [Synthetic package requests](../contributing/decisions/0013-synthetic-package-requests.md)
