# Skills, saved apps, and generated UI

## Saved skills

**meta_save_skill** stores repeatable **codemode** workflows. Save patterns you
expect to run again with similar structure; run one-off work with **execute**
instead.

Skills can declare **parameters**; pass values through **meta_run_skill**
**`params`** and read them as **`params`** inside the skill code.

Optional **collection** groups related skills. Use **meta_get_skill**,
**meta_list_skill_collections**, and **meta_delete_skill** for lifecycle tasks.

## Saved apps (MCP App artifacts)

**ui_save_app** persists reusable **generated UI** as a saved app record with:

- **`clientCode`** — the HTML UI rendered inside the generic shell
- **`serverCode`** — optional Durable Object facet backend code
- **`serverCodeId`** — rotated automatically on each save when backend code
  changes so Cloudflare reloads the Dynamic Worker

Reopen with **open_generated_ui** using **`app_id`**, or discover apps via
**search**.

Saved apps can be **hidden** from search by default; set **`hidden: false`**
when the app should appear in discovery for reuse.

Saved app backends run behind **`/app/:appId/*`** with their own isolated
SQLite database per facet. The default facet is **`main`**. Additional named
facets such as **`jobs`** or **`cache`** are supported by the lifecycle
capabilities.

Use these lifecycle capabilities when you need backend maintenance:

- **`app_storage_reset`**
- **`app_storage_export`**
- **`app_server_exec`**
- **`app_delete`**

See [Saved app backends](./saved-app-backends.md) for the route contract, RPC
bridge surface, and a complete **counter app** example.

## Generated UI

**open_generated_ui** accepts exactly one of **`code`** (inline source) or
**`app_id`** (reopen saved). **`params`** applies to saved apps with declared
parameters.

Import **`kodyWidget`** from **`@kody/ui-utils`** for helpers, **`executeCode`**
for low-level server calls, secrets, values, OAuth, and forms. Use generated UI
when the user must enter sensitive data instead of pasting into chat.

`kodyWidget.executeCode(code, params?)` also accepts optional per-call JSON
params. Those values are injected as **`params`** inside the async function and
override saved-app/session params for that execution only.

Saved app client code can also use **`kodyWidget.appBackend`** to discover the
scoped backend base path for direct requests such as
**`fetch(\`\${kodyWidget.appBackend?.basePath}/api/counter\`)`**.

If a skill or saved app depends on a third-party integration, run
**`kody_official_guide`** with **`guide`** **`integration_bootstrap`** first.
For third-party OAuth, then run **`guide`** **`oauth`** (hosted
**`/connect/oauth`**). Use **`guide`** **`generated_ui_oauth`** only for OAuth
built inside a saved app.
