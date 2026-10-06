/**
 * True when authored package modules reference `kody.mcp`. Those apps need
 * MCP server names advertised before Workerd ownKeys+GOPD destructuring, so
 * the generated entrypoint preloads `listMcpServerNames`. Hello-world and
 * other non-MCP modules stay on the lazy loader path.
 */
export function modulesReferenceKodyMcp(
	modules: Record<string, string>,
): boolean {
	const pattern = /\bkody\s*\.\s*mcp\b|\bkody\s*\[\s*['"]mcp['"]\s*\]/
	return Object.values(modules).some((source) => pattern.test(source))
}
