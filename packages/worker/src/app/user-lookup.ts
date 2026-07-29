/**
 * Compatibility re-export. Public user identity lookups moved to
 * `#worker/identity/user-lookup.ts` so MCP capabilities can resolve usernames
 * without importing from the app layer.
 */
export * from '#worker/identity/user-lookup.ts'
