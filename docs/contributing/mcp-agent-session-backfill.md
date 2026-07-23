# MCP Agent session backfill

Migration `0086` indexes MCP Agent Durable Object ids by stable user id. Before
account deletion may run in an environment, dormant objects created before that
migration must be indexed and the version-1 completion marker must be written.

The operator sweep uses Cloudflare's Durable Objects list API and the existing
`CAPABILITY_REINDEX_SECRET` maintenance authentication. Never pass secrets as
CLI flags or commit audit output.

## Required environment

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` with Workers/Durable Objects read access
- `CAPABILITY_REINDEX_SECRET`

## Dry run

```bash
npm run backfill:mcp-agent-sessions -- \
  --origin https://heykody.dev \
  --worker-script kody \
  --audit-out /tmp/mcp-agent-session-backfill-dry-run.json
```

The command resolves the `MCP` namespace, cursor-pages every object with stored
data, and calls the maintenance ownership RPC in batches of 50 without writing
index rows. Review every `no_owner`, conflict, and failure before execution.

## Execute

```bash
npm run backfill:mcp-agent-sessions -- \
  --origin https://heykody.dev \
  --worker-script kody \
  --audit-out /tmp/mcp-agent-session-backfill-execute.json \
  --execute
```

Execution is idempotent. It registers same-owner rows, rejects ownership
conflicts, writes an audit artifact, and writes completion marker version `1`
only when no failures remain. Account deletion fails closed with HTTP 503 until
that marker exists. Do not run the production execute command from an agent; an
operator must review the dry-run artifact first.
