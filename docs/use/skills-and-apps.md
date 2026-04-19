# Skills, saved apps, and generated UI

## Saved skills

**meta_save_skill** stores repeatable **codemode** workflows. Save patterns you
expect to run again with similar structure; run one-off work with **execute**
instead.

Skills can declare **parameters**; pass values through **meta_run_skill**
**`params`** and read them as **`params`** inside the skill code.

Repo-backed saved skills can also span multiple files. Kody bundles the saved
artifact repo and executes its ES module entrypoint with the same **execute**
runtime semantics (including `codemode`, OAuth helpers, and skill params).

Optional **collection** groups related skills. Use
**meta_list_skill_collections**, **meta_run_skill**, and **meta_delete_skill**
for lifecycle tasks.

## Saved apps (MCP App artifacts)

**ui_save_app** persists reusable **generated UI** as a saved app record with:

- **`clientCode`** — HTML rendered inside the generic shell
- **`serverCode`** — Durable Object facet backend code for real app logic
- **`serverCodeId`** — rotated automatically on each save when backend code
  changes so Cloudflare reloads the Dynamic Worker

`clientCode` supports **HTML only**. Put browser-side logic inside
`<script type="module">...</script>` tags in that HTML.

For non-trivial saved apps, treat **`serverCode`** plus
**`kodyWidget.appBackend.fetch(...)`** as the default pattern:

- put provider API calls, persistence, validation, and mutations in
  **`serverCode`**
- expose backend routes such as **`/api/state`** and **`/api/action`**
- keep **`clientCode`** mostly UI plus `kodyWidget.appBackend.fetch(...)` calls
  to the app backend
- reserve embedded **`kodyWidget.executeCode(...)`** strings in client HTML for
  quick prototypes or one-off experiments

When updating an existing saved app with `app_id`, omitted fields preserve the
current saved value. Omit `serverCode` to keep the existing backend, or pass
`serverCode: null` to clear it explicitly.

Reopen with **open_generated_ui** using **`app_id`**, or discover apps via
**search**.

Saved apps can be **hidden** from search by default; set **`hidden: false`**
when the app should appear in discovery for reuse.

Saved app backends run behind **`/app/:appId/*`** with their own isolated SQLite
database per facet. The default facet is **`main`**. Additional named facets
such as **`jobs`** or **`cache`** are supported by the lifecycle capabilities.

Use these lifecycle capabilities when you need backend maintenance:

- **`app_storage_reset`**
- **`app_storage_export`**
- **`app_server_exec`** — compiles a throwaway exec worker with an explicit
  `app.call(methodName, ...args)` RPC bridge to the saved app facet
- **`app_delete`**

See [Saved app backends](./saved-app-backends.md) for the route contract, RPC
bridge surface, and the default **`/api/state`** + **`/api/action`** pattern.

## Generated UI

**open_generated_ui** accepts exactly one of **`code`** (inline source) or
**`app_id`** (reopen saved). **`params`** applies to saved apps with declared
parameters.

Import **`kodyWidget`** from **`@kody/ui-utils`** for helpers, app-backend
discovery, secrets, values, OAuth, forms, and **`executeCode`** when you truly
need an inline server snippet. Use generated UI when the user must enter
sensitive data instead of pasting into chat.

`kodyWidget.executeCode(code, params?)` also accepts optional per-call JSON
params. Those values are injected as **`params`** inside the async function and
override saved-app/session params for that execution only.

For saved apps with real logic, use **`kodyWidget.appBackend`** as the default
client-to-backend path:

**`await kodyWidget.appBackend.fetch('/api/state')`**

That keeps **`clientCode`** focused on UI while **`serverCode`** handles the
backend contract.

If a skill or saved app depends on a third-party integration, run
**`kody_official_guide`** with **`guide`** **`integration_bootstrap`** first.
After the authenticated smoke test passes and you are ready to build the saved
app itself, use **`guide`** **`integration_backed_app`** for the default
serverCode-first pattern. For third-party OAuth, then run **`guide`**
**`oauth`** (hosted **`/connect/oauth`**). Use **`guide`**
**`generated_ui_oauth`** only for OAuth built inside a saved app.
