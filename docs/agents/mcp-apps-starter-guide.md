# MCP Apps starter guide

This guide explains how to build MCP Apps in this starter project in a reusable
way. It is intentionally **not** tied to the calculator example.

Use this when replacing starter tools/resources with your own product-specific
UI and workflows.

## Goals

- Build MCP tools that can open interactive UI widgets in MCP App-compatible
  hosts.
- Keep tool/resource metadata aligned with the MCP Apps specification.
- Keep implementation modular so starter examples are easy to replace.
- Ensure apps support host messaging, theming, and predictable validation.

## Architecture in this repo

Use this file map as the default structure:

- `mcp/index.ts`
  - MCP server + `init()` registration entrypoint.
- `mcp/register-tools.ts`
  - Aggregates tool registration.
- `mcp/register-resources.ts`
  - Aggregates resource registration.
- `mcp/tools/*.ts`
  - One tool per file.
- `mcp/resources/*.ts`
  - One resource registration module per file.
- `mcp/apps/*.ts`
  - UI entry-point modules that return HTML/JS payloads for `ui://` resources.

## Recommended implementation workflow

### 1) Create an app entry point

Create a dedicated module under `mcp/apps/`:

- Export a stable `ui://` URI.
- Export a render function that returns the app HTML.
- Keep widget logic local to this module.

Keep file names lower-kebab-case and prefer one entry point per app.

### 2) Register the app resource

In `mcp/resources/<your-resource>.ts`:

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

In `mcp/tools/<your-tool>.ts`:

- Use `registerAppTool(...)` from `@modelcontextprotocol/ext-apps/server`.
- Set `_meta.ui.resourceUri` to the **same** `ui://` URI as the resource.
- Include annotations (`readOnlyHint`, `idempotentHint`, etc.).
- Provide `outputSchema` for machine-usable outputs where relevant.

### 4) Wire registration in server init

- Add resource registration to `mcp/register-resources.ts`.
- Add tool registration to `mcp/register-tools.ts`.
- Ensure `mcp/index.ts` calls both in `init()`.

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
- Keep messages concise and deterministic where possible.
- For inline `rawHtml` widgets in this repo, prefer reusing the shared runtime
  in `client/mcp-apps/widget-host-bridge.ts` (bundled into
  `public/mcp-apps/calculator-widget.js`) instead of duplicating bridge code.

You can also send simplified MCP-UI actions via `window.parent.postMessage(...)`
(`type: 'tool' | 'prompt' | 'notify' | 'link'`) when using the `mcpApps`
adapter. Those shorthand actions depend on adapter translation and may not be
available in every host runtime.

## Theme and design-system guidance

### Theme support

For robust light/dark behavior:

- Support browser fallback with `prefers-color-scheme`.
- Also support host-provided theme:
  - Request render data (`ui-request-render-data`).
  - Handle host updates (`ui-lifecycle-iframe-render-data`).
  - Apply `renderData.theme` (`light`/`dark`) when present.

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
- Confirm docs in `docs/agents` reflect any new workflow or constraints.

## Replacing starter examples safely

When removing starter examples (for example calculator + math tool):

1. Delete example modules under `mcp/apps`, `mcp/tools`, and `mcp/resources`.
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
- Worker MCP entrypoint wiring: `worker/index.ts`
