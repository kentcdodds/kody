# MCP Apps starter guide

This guide explains how to build MCP Apps in this starter project in a reusable
way. The current implementation uses a single generic shell resource that can
render inline generated code or reopen saved UI artifacts by id. The shell is
intentionally thin: it just hosts an iframe, delivers render payloads, and
bridges host actions back to the MCP App host.

Use this when replacing starter tools/resources with your own product-specific
UI and workflows.

## Goals

- Build MCP tools that can open interactive UI widgets in MCP App-compatible
  hosts.
- Keep tool/resource metadata aligned with the MCP Apps specification.
- Keep implementation modular so starter examples are easy to replace.
- Ensure apps support host messaging and predictable validation.

## Architecture in this repo

Use this file map as the default structure:

- `packages/worker/src/mcp/index.ts`
  - MCP server + `init()` registration entrypoint.
- `packages/worker/src/mcp/register-tools.ts`
  - Aggregates tool registration.
- `packages/worker/src/mcp/register-resources.ts`
  - Aggregates resource registration.
- `packages/worker/src/mcp/tools/*.ts`
  - One tool per file.
- `packages/worker/src/mcp/resources/*.ts`
  - One resource registration module per file.
- `packages/worker/src/mcp/apps/*.ts`
  - UI entry-point modules that return HTML/JS payloads for `ui://` resources.

## Recommended implementation workflow

### 1) Create an app entry point

Create a dedicated module under `packages/worker/src/mcp/apps/`:

- Export a stable `ui://` URI.
- Export a render function that returns the app HTML.
- Keep shell markup minimal and push visible UI into the generated app source.

Keep file names lower-kebab-case and prefer one entry point per app.

### 2) Register the app resource

In `packages/worker/src/mcp/resources/<your-resource>.ts`:

- Use `registerAppResource(...)` from `@modelcontextprotocol/ext-apps/server`.
- Return `text/html;profile=mcp-app`.
- Use `createUIResource(...)` from `@mcp-ui/server` when you need adapter
  injection.
- Enable the `mcpApps` adapter when UI events should be translated into MCP Apps
  host JSON-RPC.
- Set `_meta.ui.domain` on resource contents to the widget origin (required for
  app submission).
- Add `_meta["openai/widgetDomain"]` as a compatibility alias for ChatGPT.

### 3) Register the app-opening tool

In `packages/worker/src/mcp/tools/<your-tool>.ts`:

- Use `registerAppTool(...)` from `@modelcontextprotocol/ext-apps/server`.
- Set `_meta.ui.resourceUri` to the **same** `ui://` URI as the resource.
- Include annotations (`readOnlyHint`, `idempotentHint`, etc.).
- Provide `outputSchema` for machine-usable outputs where relevant.
- Prefer returning a compact render envelope in `structuredContent` so a single
  shell can render different app payloads per invocation.
- Prefer self-contained HTML documents or fragments as the render source so the
  generated app owns the visible document.

### 4) Wire registration in server init

- Add resource registration to `packages/worker/src/mcp/register-resources.ts`.
- Add tool registration to `packages/worker/src/mcp/register-tools.ts`.
- Ensure `packages/worker/src/mcp/index.ts` calls both in `init()`.

### 5) Add or update MCP E2E coverage

At minimum, cover:

- `listTools` includes your new tool.
- `listResources` includes your `ui://` resource.
- `readResource` returns expected MIME type + payload markers.
- `readResource` metadata includes widget domain + CSP expectations.
- `callTool` returns expected content/structuredContent.

## Host messaging patterns

When a UI should communicate back to the host agent:

- Prefer the standard MCP Apps bridge (`App` from
  `@modelcontextprotocol/ext-apps`) and call host methods such as:
  - `ui/message` (send a user-style message)
  - `tools/call` (call server tools)
  - `ui/open-link` (request external link open)
- Use app-only tools (`visibility: ["app"]`) for server-side follow-up work that
  should stay out of the model tool list, such as loading saved app source by id
  or polling for live widget state.
- Keep messages concise and deterministic where possible.
- For inline `rawHtml` widgets in this repo, prefer reusing the shared runtime
  in `packages/worker/client/mcp-apps/widget-host-bridge.ts` (bundled into
  `packages/worker/public/mcp-apps/generated-ui-shell.js`) instead of
  duplicating bridge code.

You can also send simplified MCP-UI actions via `window.parent.postMessage(...)`
(`type: 'tool' | 'prompt' | 'notify' | 'link'`) when using the `mcpApps`
adapter. Those shorthand actions depend on adapter translation and may not be
available in every host runtime.

### Fullscreen and display modes

- Prefer `ui/request-display-mode` for fullscreen entry/exit instead of trying
  to manipulate the iframe directly.
- Treat fullscreen as host-dependent. Always check `availableDisplayModes` from
  render data / host context before offering the action.
- Keep fullscreen UI optional and degrade gracefully when unsupported.

### Generic shell render contract

The current repo uses one generic shell resource:

- `ui://generated-ui-shell/entry-point.html`

The public tool should accept exactly one of:

- inline source (ephemeral render)
- saved `app_id` (server-resolved reopen)

Recommended render envelope fields in tool `structuredContent`:

- render mode (`inline_code` or `saved_app`)
- saved artifact id when present
- optional title / description for the current render session
- inline source only for ephemeral renders

This keeps the shell reusable while avoiding source round-trips through the
model for saved artifacts.

## HTML-First Contract

Prefer generated app source that is already a complete HTML document, or at
least a self-contained HTML fragment. That keeps the generic shell simple and
avoids coupling the app contract to shell-owned containers like `#app`.

If you keep a helper bridge, treat it as transport only:

- send host messages
- request display modes
- call app-only tools
- avoid shipping shell-owned visible controls

## Theme and design-system guidance

### Theme support

For robust light/dark behavior:

- Support browser fallback with `prefers-color-scheme`.
- If your generated app wants host-provided theme, pass it through your bridge
  contract explicitly rather than relying on shell-owned UI chrome.

### Design-system alignment

Prefer app token names so widgets stay visually consistent with the host app:

- `--color-*`
- `--spacing-*`
- `--radius-*`
- `--shadow-*`
- shared typography tokens (`--font-*`)

When app and widget are served from the same origin, prefer referencing the
canonical stylesheet directly (for example `/styles.css`) instead of copying
token values into widget CSS. If you do this in an MCP App resource, set
`_meta.ui.csp.resourceDomains` to allow that stylesheet origin.

## Security and metadata checklist

- Keep resources sandbox-friendly (no unnecessary external dependencies).
- If loading external assets/APIs, define explicit `_meta.ui.csp` domains.
- When serving widget JS/CSS from your app origin (for example `/mcp-apps/*` or
  `/styles.css`), add `Access-Control-Allow-Origin` so sandboxed iframes with
  opaque origins can fetch assets in ChatGPT/MCP Jam.
- If you use Workers static assets, configure `assets.run_worker_first` for
  widget asset paths so those requests pass through your CORS logic.
- Always set `_meta.ui.domain` and `_meta["openai/widgetDomain"]` to your app's
  dedicated widget origin.
- Request only required permissions in `_meta.ui.permissions`.
- Avoid embedding secrets or private tokens in UI payloads.

## Quality checklist before merge

- `bun run format`
- `bun run test:mcp`
- `bun run validate`
- `bun run inspect`
- Confirm docs in `docs/agents` reflect any new workflow or constraints.

## Inspector and MCP Jam verification

For end-to-end verification beyond local MCP tests:

1. Run `bun run inspect`.
2. Connect the local MCP server in the inspector / MCP Jam flow.
3. Call the generic app-opening tool with inline source and confirm the shell
   renders the generated UI.
4. Save an app artifact, then reopen it by `app_id` and confirm the shell loads
   it without resending the saved source through the model.
5. Verify host interactions that are supported by your widget:
   - `ui/message`
   - app-only `tools/call`
   - `ui/open-link`
   - `ui/request-display-mode` / fullscreen when the host exposes it

Treat MCP Jam as the highest-signal browser verification path because it matches
the sandboxed MCP Apps host model more closely than a plain iframe.

## Replacing starter examples safely

When removing starter examples:

1. Delete example modules under `packages/worker/src/mcp/apps`,
   `packages/worker/src/mcp/tools`, and `packages/worker/src/mcp/resources`.
2. Replace entries in registration modules.
3. Update MCP E2E tests to your new tool/resource names and behavior.
4. Update this guide (or adjacent docs) if your project-specific conventions
   differ from defaults.

## References

Core MCP Apps docs/spec:

- MCP UI introduction: https://mcpui.dev/guide/introduction
- `@modelcontextprotocol/ext-apps` repository:
  https://github.com/modelcontextprotocol/ext-apps
- MCP Apps API docs: https://apps.extensions.modelcontextprotocol.io/api/
- MCP Apps stable spec (2026-01-26):
  https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx

Repo-specific implementation references:

- MCP server patterns: `docs/mcp-server-patterns.md`
- Cloudflare Agents SDK notes: `docs/agents/cloudflare-agents-sdk.md`
- Worker MCP entrypoint wiring: `packages/worker/src/index.ts`
