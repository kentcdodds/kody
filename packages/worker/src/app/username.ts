/**
 * Compatibility re-export. Username normalization and validation moved to
 * `#worker/identity/username.ts` so MCP capabilities and package runtimes can
 * validate usernames without importing from the app layer.
 */
export * from '#worker/identity/username.ts'
