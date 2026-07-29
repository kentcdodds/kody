/**
 * Compatibility re-export. The audit log sink moved to `#worker/audit-log.ts`
 * so MCP capabilities can record audit events without importing from the app
 * layer. Test doubles mock the canonical path, not this one — see
 * `#worker/test-support/audit-log-spy.ts`.
 */
export * from '#worker/audit-log.ts'
