/**
 * Compatibility re-export. Public-origin resolution moved to
 * `#worker/app-base-url.ts` so MCP capabilities can resolve the app and
 * package-app origins without importing from the app layer.
 */
export * from '#worker/app-base-url.ts'
