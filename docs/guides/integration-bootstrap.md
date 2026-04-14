# Integration bootstrap guide

**Read this guide first** when a user wants a skill, app, or workflow that
depends on a third-party integration such as Spotify, GitHub, Slack, Linear, or
Stripe.

This guide is about **ordering**. The goal is to finish the integration setup
and prove it works **before** you save or present downstream skills or apps that
depend on it.

## What counts as an integration bootstrap

Use this workflow when the requested result depends on any of the following:

- an OAuth connector
- a saved secret such as an API key or PAT
- host approvals for outbound API calls
- a saved app or skill that assumes authenticated API access already works

## Core rule

Do **not** save or present an auth-dependent skill or app as complete until:

1. the required connector or secret exists
2. the user has finished any required connect flow
3. a minimal authenticated smoke test succeeds end-to-end

If those conditions are not met, stop and fix the integration first.

## Bootstrap sequence

1. Decide which auth path the integration needs.
   - Standard OAuth: load `kody_official_guide` with `guide: "oauth"`.
   - API key or PAT: load `kody_official_guide` with `guide: "connect_secret"`.
   - OAuth inside a saved app: load `guide: "oauth"` first, then use
     `guide: "generated_ui_oauth"` only when you deliberately need the saved-app
     callback flow.
2. Inspect current integration state before building downstream artifacts.
   - Use `search` to look for saved connectors and secret references for the
     integration.
   - When you need one item’s full metadata, inspect it with
     `search({ entity: "{id}:connector" })` or
     `search({ entity: "{id}:secret" })`.
3. If the required connector or secret is missing, **stop**.
   - Surface the exact `/connect/oauth` or `/connect/secret` URL in chat.
   - Wait for the user to confirm they completed the connect flow.
   - Do not save a downstream auth-dependent skill or app yet.
4. After the user confirms setup, run a minimal authenticated smoke test in
   `execute`.
   - Use the real auth path the final integration will use.
   - Prefer a cheap read-only request such as `GET /me`, `GET /viewer`, or a
     similarly small account/profile endpoint.
   - Confirm the connector or secret name, token refresh behavior, and allowed
     hosts all work end-to-end.
5. Only after the smoke test succeeds should you build or save the dependent
   skill or app.
   - If the connector or tokens already exist and the smoke test passes, proceed
     directly to app or skill construction.
   - Do not spend extra time exploring the local repo when the connector state,
     secret names, allowed hosts, and provider contract are already clear
     enough.
   - For the default saved-app structure after bootstrap, load
     `kody_official_guide` with `guide: "integration_backed_app"`.
6. If the smoke test fails, keep working on integration setup. Do not treat the
   downstream artifact as ready.

## Smoke test expectations

The smoke test should prove the same auth wiring the final skill or app will
depend on:

- the expected connector or secret exists
- the request reaches the intended API host
- the request is authenticated successfully
- any required host approvals are in place
- the agent is using the correct secret names, connector name, and API base URL

## Important exceptions

The main exception is a saved app whose explicit purpose is to complete
`generated_ui_oauth`.

Even in that case:

- the saved app should be treated as the **setup** surface, not the finished
  downstream integration
- any later skill or app that depends on the resulting connector or tokens
  should wait until the post-connect smoke test passes

## Recommended phrasing in chat

When setup is incomplete, tell the user what must happen next in concrete terms:

- what connect URL to open
- what provider settings or redirect URI to register
- that you are waiting for confirmation before building the dependent skill or
  app
- that you will run a minimal authenticated verification step after setup

## Anti-patterns

Avoid these common mistakes:

- building a polished UI first and only discovering later that auth is missing
- saving an app that assumes a non-existent secret or connector
- treating a rendered app as success when the first authenticated API call still
  fails
- using `generated_ui_oauth` by default instead of the standard `/connect/oauth`
  path
- skipping the authenticated smoke test after the user completes setup
