# Connect your agent

Kody is an MCP server. You use it from Cursor, Claude Desktop, or any other AI
agent that supports MCP — not from a separate Kody chat app.

## Add the MCP server

1. In your agent host, add a remote MCP server.
2. Use this deployment’s MCP URL: `https://<this-host>/mcp`. The in-app Get
   started page (`/onboarding`) shows the exact URL for the host you are on.
3. Complete the OAuth flow when the host opens it. Sign in to Kody if needed,
   then approve access.

Your account email must be verified before authorize can finish or MCP can run.
If authorize asks you to verify, keep that tab open, finish verification (from
the email link or `/pending-verification`), then continue. You do not need to
restart the host connection. Unverified visits to Get started (`/onboarding`)
redirect to `/pending-verification`; after verification, onboarding shows the
MCP URL and setup prompt.

## Ask your agent to help set up

After the connection works, paste a short setup prompt into your agent (the Get
started page has a copy button). Ask it to explain what Kody can do and help
configure secrets, integrations, or packages you need.

## Where to go next

- [First steps](./first-steps.md) — search-first habits and common goals
- [Troubleshooting](./troubleshooting.md) — auth, empty results, and approvals
