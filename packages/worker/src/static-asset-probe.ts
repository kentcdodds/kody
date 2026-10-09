import { oauthPaths } from '#universal/oauth-paths.ts'
import { routePattern } from '#universal/route-pattern.ts'
import { routes } from '#universal/routes.ts'
import { mcpResourcePath } from './mcp-auth.ts'
import { retiredConnectorsPathPrefix } from './user-namespace-routes.ts'

/**
 * Top-level directories in `packages/worker/public`. A Remix route that
 * shares one of these names (today `/og/:page.png`) still probes ASSETS so
 * worker-first dev can serve the files beside the route. The node test
 * fails if any file under `public/` would skip the probe.
 */
const publicAssetDirectoryNames = new Set(['fonts', 'images', 'og'])

function literalRootSegment(pattern: string) {
	const trimmed =
		pattern.length > 1 && pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
	if (!trimmed.startsWith('/')) return null
	const body = trimmed.slice(1)
	if (
		body.length === 0 ||
		body.startsWith('@') ||
		body.startsWith(':') ||
		body.startsWith('*')
	) {
		return null
	}
	const slash = body.indexOf('/')
	const segment = slash === -1 ? body : body.slice(0, slash)
	if (segment.length === 0 || /[:*(]/.test(segment)) return null
	return segment
}

function collectDynamicRootSegments() {
	const segments = new Set<string>()
	const add = (pattern: string) => {
		const segment = literalRootSegment(pattern)
		if (!segment || publicAssetDirectoryNames.has(segment)) return
		segments.add(segment)
	}
	for (const route of Object.values(routes)) {
		add(routePattern(route))
	}
	for (const pathname of Object.values(oauthPaths)) {
		add(pathname)
	}
	add(mcpResourcePath)
	add(retiredConnectorsPathPrefix)
	return segments
}

const dynamicRootSegments = collectDynamicRootSegments()

const atPrefixIsDynamic = Object.values(routes).some((route) =>
	routePattern(route).startsWith('/@'),
)

/**
 * True when this pathname is owned by the app router (or a pre-router mount
 * such as `/mcp`) and has no twin in the ASSETS binding. Prefixes come from
 * `routes.ts` plus OAuth, MCP, and the retired `/connectors` mount.
 */
export function requestSkipsAssetProbe(pathname: string) {
	if (atPrefixIsDynamic && (pathname === '/@' || pathname.startsWith('/@'))) {
		return true
	}
	const segment = pathname.split('/')[1]
	if (!segment || publicAssetDirectoryNames.has(segment)) return false
	return dynamicRootSegments.has(segment)
}
