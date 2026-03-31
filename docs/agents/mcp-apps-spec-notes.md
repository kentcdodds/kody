# MCP Apps Spec Notes

This repo currently uses one generic MCP Apps shell rather than a family of app
implementations. For MCP Apps behavior, prefer the upstream spec and API docs
over project-local conventions.

## Read First

- [MCP Apps API docs](https://apps.extensions.modelcontextprotocol.io/api/)
- [MCP Apps stable spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
- [MCP UI introduction](https://mcpui.dev/guide/introduction)
- [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps)

## Repo-Specific Notes

- The repo exposes a single generic shell via `open_generated_ui`.
- Saved apps are reopened by `app_id`; inline renders are ephemeral.
- Saved apps are hidden from `search` by default; set
  `hidden: false` in `ui_save_app` only for reusable apps that
  should be discoverable.
- If an OAuth provider requires a callback URL, use a persisted hosted saved app
  rather than an inline render.
- For secret-bearing requests and host approval policy, also read
  [`secret-host-approval.md`](./secret-host-approval.md).

## Relevant Code

- `packages/worker/src/mcp/tools/open-generated-ui.ts`
- `packages/worker/client/mcp-apps/kody-ui-utils.ts`
- `packages/worker/client/routes/saved-ui.tsx`
