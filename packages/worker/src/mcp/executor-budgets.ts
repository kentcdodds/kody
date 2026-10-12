/**
 * Sandbox budget for interactive runs: MCP and ad-hoc execute, package export
 * HTTP invokes, and synchronous webhooks.
 */
export const defaultExecutorTimeoutMs = 90_000

/**
 * Sandbox budget for background runs nobody waits on: jobs (and package exports
 * they import), async webhook deliveries, and workflow steps. Same on every
 * plan. Long enough for one fetch to use its full 5-minute deadline.
 */
export const backgroundExecutorTimeoutMs = 5 * 60_000
