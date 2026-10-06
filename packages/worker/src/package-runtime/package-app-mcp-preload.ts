import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	packageRuntimeModulePrefix,
	publicRuntimeModulePath,
	runtimeModulePath,
} from './module-graph-paths.ts'

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
const staticImportFromPattern = /\bfrom\s+['"]([^'"]+)['"]/g
const mcpAccessPattern = /\.\s*mcp\b|\[\s*['"]mcp['"]\s*\]/

/**
 * Bundled package-app modules rewrite `kody:runtime` to a relative virtual
 * path (`public-runtime.js`, `runtime.js`, or `package-runtime/<id>.js`).
 * Match both the bare specifier and those rewritten forms.
 */
function isKodyRuntimeImportSpecifier(specifier: string): boolean {
	if (specifier === 'kody:runtime') return true
	if (
		specifier === runtimeModulePath ||
		specifier.endsWith(`/${runtimeModulePath}`) ||
		specifier === publicRuntimeModulePath ||
		specifier.endsWith(`/${publicRuntimeModulePath}`)
	) {
		return true
	}
	const packageRuntimeSegment = `/${packageRuntimeModulePrefix}/`
	return (
		(specifier.startsWith(`${packageRuntimeModulePrefix}/`) ||
			specifier.includes(packageRuntimeSegment)) &&
		specifier.endsWith('.js')
	)
}

function sourceImportsKodyRuntime(source: string): boolean {
	for (const match of source.matchAll(staticImportFromPattern)) {
		const specifier = match[1]
		if (specifier != null && isKodyRuntimeImportSpecifier(specifier)) {
			return true
		}
	}
	return false
}

/**
 * True when authored package modules reference `kody.mcp`. Those apps need
 * MCP server names advertised before Workerd ownKeys+GOPD destructuring, so
 * the generated entrypoint preloads `listMcpServerNames`. Hello-world and
 * other non-MCP modules stay on the lazy loader path.
 *
 * Also treats `import { kody as api } from 'kody:runtime'` plus `api.mcp`
 * as a hit (including after the bundler rewrites the specifier to a virtual
 * runtime path): the direct `kody.mcp` regex misses renamed bindings.
 */
export function modulesReferenceKodyMcp(modules: WorkerLoaderModules): boolean {
	return Object.values(modules).some((module) => {
		const source = readModuleSource(module)
		if (source == null) return false
		if (directKodyMcpPattern.test(source)) return true
		return sourceImportsKodyRuntime(source) && mcpAccessPattern.test(source)
	})
}
