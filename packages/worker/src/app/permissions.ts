/**
 * Compatibility re-export. The role/permission catalog moved to
 * `#worker/identity/permissions.ts` so MCP capabilities can enforce access
 * control without importing from the app layer. Client routes and loader-data
 * payload types still read the role names through this app-layer path.
 */
export * from '#worker/identity/permissions.ts'
