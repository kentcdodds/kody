# Apps and generated UI

## Apps are the top-level persisted unit

Kody persists personal automation as **apps**.

An app can include any combination of:

- **client UI** — HTML rendered inside the generic UI shell
- **server backend** — request/RPC code behind the app backend
- **tasks** — named callable codemode entrypoints
- **jobs** — named scheduled entrypoints

That means you no longer need to think in terms of separate persisted units for
automation, schedules, and UI. One repo-backed app can expose all of those
surfaces together.

## Saving an app

Use **`app_save`** to create or replace an app package.

Typical fields:

- **`title`** — human-readable app name
- **`description`** — what the app does
- **`clientCode`** — optional HTML UI
- **`serverCode`** — optional backend code
- **`tasks`** — optional named callable tasks
- **`jobs`** — optional named scheduled jobs

For non-trivial apps, prefer:

- provider API calls, persistence, and validation in **`serverCode`**
- lightweight UI in **`clientCode`**
- named automation entrypoints in **`tasks`**
- recurring automation in **`jobs`**

When updating an existing app with `app_id`, omitted fields preserve the
current saved value unless the capability says otherwise.

## Running app tasks and jobs

Use:

- **`app_run_task`** for named callable automation inside an app
- **`app_run_job`** to trigger a named scheduled job immediately

These app entrypoints execute with the same codemode-style capability model as
the rest of Kody’s server-side automation surface.

## Opening app UI

Use **`open_generated_ui`** with **`app_id`** to reopen a saved app UI, or
**`code`** for a one-off inline UI.

Import **`kodyWidget`** from **`@kody/ui-utils`** for helpers, app-backend
discovery, secrets, values, OAuth, forms, and **`executeCode`** when you truly
need an inline server snippet. Use generated UI when the user must enter
sensitive data instead of pasting into chat.

For saved apps with real logic, use **`kodyWidget.appBackend`** as the default
client-to-backend path:

**`await kodyWidget.appBackend.fetch('/api/state')`**

That keeps **`clientCode`** focused on UI while **`serverCode`** handles the
backend contract.

## App backends

Saved app backends run behind **`/app/:appId/*`** with isolated SQLite storage
per facet. The default facet is **`main`**.

Use these lifecycle capabilities when you need backend maintenance:

- **`app_storage_reset`**
- **`app_storage_export`**
- **`app_server_exec`** — compiles a throwaway exec worker with an explicit
  `app.call(methodName, ...args)` RPC bridge to the saved app facet
- **`app_delete`**

See [Saved app backends](./saved-app-backends.md) for the route contract, RPC
bridge surface, and the default **`/api/state`** + **`/api/action`** pattern.

## Integrations and OAuth

If an app depends on a third-party integration, run **`kody_official_guide`**
with **`guide`** **`integration_bootstrap`** first.

After the authenticated smoke test passes and you are ready to build the app
itself, use **`guide`** **`integration_backed_app`** for the default
serverCode-first pattern.

For third-party OAuth, then run **`guide`** **`oauth`** (hosted
**`/connect/oauth`**). Use **`guide`** **`generated_ui_oauth`** only for OAuth
built inside a saved app.
