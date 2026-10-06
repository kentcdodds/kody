import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'

function readModuleSource(
	module: WorkerLoaderModules[string] | undefined,
): string | null {
	if (typeof module === 'string') return module
	if (typeof module?.js === 'string') return module.js
	if (typeof module?.cjs === 'string') return module.cjs
	if (typeof module?.text === 'string') return module.text
	return null
}

/**
 * True when authored package modules reference `kody.mcp`. Those apps need
 * MCP server names advertised before Workerd ownKeys+GOPD destructuring, so
 * the generated entrypoint preloads `listMcpServerNames`. Hello-world and
 * other non-MCP modules stay on the lazy loader path.
 */
export function modulesReferenceKodyMcp(modules: WorkerLoaderModules): boolean {
	const pattern = /\bkody\s*\.\s*mcp\b|\bkody\s*\[\s*['"]mcp['"]\s*\]/
	return Object.values(modules).some((module) => {
		const source = readModuleSource(module)
		return source != null && pattern.test(source)
	})
}
