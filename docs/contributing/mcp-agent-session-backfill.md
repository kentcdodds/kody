# MCP Agent session backfill

Migration `0086` indexes MCP Agent Durable Object ids by stable user id. Before
account deletion may run in an environment, dormant objects created before that
migration must be indexed and the version-1 completion marker must be written.

The operator sweep uses Cloudflare's Durable Objects list API and the existing
`CAPABILITY_REINDEX_SECRET` maintenance authentication. Never pass secrets as
CLI flags or commit audit output.

## Preferred: GitHub Actions

Use the `🧭 Backfill MCP agent sessions` workflow
(`.github/workflows/backfill-mcp-agent-sessions.yml`):

```bash
gh workflow run backfill-mcp-agent-sessions.yml \
  -f mode=dry-run \
  -f origin=https://heykody.dev \
  -f worker_script=kody-production
```

Review the uploaded audit artifact, then re-run with `-f mode=execute` when
there are no ownership conflicts or hard failures. Ownerless stored objects
(`no_owner`) are accepted in the completion audit pre-launch — they have no
`userId` to attribute for account deletion. Production inventory is large
(thousands of MCP Durable Objects); the job timeout is six hours.

## Required environment (local CLI)

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` with Workers Scripts Read (Durable Objects list)
- `CAPABILITY_REINDEX_SECRET` matching the deployed Worker secret

## Dry run (local)

```bash
npm run backfill:mcp-agent-sessions -- \
  --origin https://heykody.dev \
  --worker-script kody-production \
  --audit-out /tmp/mcp-agent-session-backfill-dry-run.json
```

The command resolves the `MCP` namespace, cursor-pages every object with stored
data, and calls the maintenance ownership RPC in batches of 50 without writing
index rows. Review conflicts and failures before execution; `no_owner` rows are
recorded but do not block completion.

## Execute (local)

```bash
npm run backfill:mcp-agent-sessions -- \
  --origin https://heykody.dev \
  --worker-script kody-production \
  --audit-out /tmp/mcp-agent-session-backfill-execute.json \
  --execute
```

Execution is idempotent. It registers same-owner rows, rejects ownership
conflicts, retries transient per-object failures once, writes an audit artifact,
and writes completion marker version `1` when no failures or ownership conflicts
remain (`no_owner` is accepted). Account deletion fails closed with HTTP 503
until that marker exists.
