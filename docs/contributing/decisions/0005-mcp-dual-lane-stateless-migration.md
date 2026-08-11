# 0005: MCP dual-lane serving with metrics-driven legacy retirement

- **Status:** accepted
- **Date:** 2026-08-05

## Context

MCP protocol revision `2026-07-28` made the protocol stateless: the `initialize`
handshake and `Mcp-Session-Id` header are removed and every request carries its
own `_meta` envelope. The Cloudflare Agents SDK deprecated and feature-froze
`McpAgent`, which hosts kody's `/mcp` as a sessionful Durable Object on MCP SDK
v1. Nearly all installed MCP clients still speak 2025-era revisions, so dropping
the sessionful path outright would break real traffic, while staying on
`McpAgent` alone pins kody to a frozen stack.

## Decision

Serve `/mcp` as two lanes behind one route and one shared tool registration
(`packages/worker/src/mcp/register-tools.ts`): 2025-era requests keep the
`McpAgent` Durable Object lane unchanged, and `2026-07-28` envelope requests are
served by a per-request stateless SDK v2 server
(`packages/worker/src/mcp/stateless-lane.ts`). Routing uses the SDK's own
`isLegacyRequest` predicate, and every authenticated request records a lane data
point to the `MCP_PROTOCOL_EVENTS` Analytics Engine dataset — deliberately not
the primary D1 database (aggregate-only readout, off the hot path; consistent
with [0002](./0002-data-placement.md)). The legacy lane is removed when the
metrics show its traffic has gone (a sustained window of zero or negligible
legacy-lane requests from real clients), not on a calendar date.

## Consequences

Modern clients get stateless serving with no MCP session Durable Object on the
request path (the account write lease taken at the auth boundary is unchanged
and applies to both lanes — it is the deletion-safety guard every kody surface
takes, not MCP session state), while every existing client keeps byte-identical
behavior. Tool definitions cannot drift between lanes, but the two SDK
generations meet at a typed seam (`asMcpToolServer` in
`packages/worker/src/mcp/mcp-registration-agent.ts`) that a future SDK bump must
revisit. Retiring the legacy lane later also deletes the `mcp_agent_sessions`
registry, the `MCP_OBJECT` Durable Object, and the session purge path. Tasks
(the `io.modelcontextprotocol/tasks` extension) are deliberately not implemented
yet: the SDK v2 ships the vocabulary without a runtime, no major client supports
it, and execute's idempotency-key + `run_get` flow already covers the need;
revisit when a major host ships task support.

## Retirement criterion (added 2026-08-10)

"Zero or negligible" is made mechanical so the retirement call is a readout, not
a judgment. Run the weighted lane query from
`packages/worker/src/mcp/protocol-metrics.ts` over a trailing 30-day window
(Analytics Engine retains 90 days, so the window is always fully covered):

```sql
SELECT blob1 AS lane, blob4 AS client_name, SUM(_sample_interval) AS requests
FROM kody_mcp_protocol_events
WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY lane, client_name
ORDER BY requests DESC
```

Retire the legacy lane when **both** hold for the window:

1. legacy-lane requests are **< 1% of total instrumented `/mcp` requests** (the
   metric records authenticated, verified, non-suspended requests — the only
   population that can contain a working legacy client, so it is the right
   denominator), and
2. **no single `client_name` bucket accounts for more than 100 legacy requests**
   — including the blank/unnamed bucket, since header-only legacy clients report
   no name; a bucket above that is a real installation that would break, not
   noise.

When both hold, remove the `McpAgent` lane, the `mcp_agent_sessions` registry
(including a D1 migration dropping the `mcp_agent_sessions` table — deleting the
Durable Object class removes its object storage but not the D1 rows), the
`MCP_OBJECT` Durable Object, and the session purge path in one change. If a
later reading fails the criterion again before the removal ships, reset the
clock — the window must be the 30 days immediately preceding the removal PR.
