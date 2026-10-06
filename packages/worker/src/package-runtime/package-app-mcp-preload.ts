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

const directKodyMcpPattern =
	/\bkody\s*\.\s*mcp\b|\bkody\s*\[\s*['"]mcp['"]\s*\]/
const kodyRuntimeImportPattern = /from\s+['"]kody:runtime['"]/
const mcpAccessPattern = /\.\s*mcp\b|\[\s*['"]mcp['"]\s*\]/

/**
 * True when authored package modules reference `kody.mcp`. Those apps need
 * MCP server names advertised before Workerd ownKeys+GOPD destructuring, so
 * the generated entrypoint preloads `listMcpServerNames`. Hello-world and
 * other non-MCP modules stay on the lazy loader path.
 *
 * Also treats `import { kody as api } from 'kody:runtime'` plus `api.mcp`
 * as a hit: the direct `kody.mcp` regex misses renamed bindings.
 */
export function modulesReferenceKodyMcp(modules: WorkerLoaderModules): boolean {
	return Object.values(modules).some((module) => {
		const source = readModuleSource(module)
		if (source == null) return false
		if (directKodyMcpPattern.test(source)) return true
		return (
			kodyRuntimeImportPattern.test(source) && mcpAccessPattern.test(source)
		)
	})
}
