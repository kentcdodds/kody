import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * Production deploy path classification: content/UI-only changes deploy the
 * app-surface Worker and skip the Durable Object–owning main/runtime/jobs
 * scripts.
 */

const appSurfaceOnlyPathPrefixes = [
	'docs/guides/',
	'packages/app-worker/',
	'packages/worker/client/',
	'packages/worker/public/',
	'packages/worker/src/blog/posts/',
	'packages/worker/src/app/handlers/',
	'packages/worker/src/app/ssr-stubs/',
	'packages/worker/universal/styles/',
] as const

const appSurfaceOnlyExactPaths = new Set([
	'packages/worker/src/app/layout.ts',
	'packages/worker/src/app/ssr-render.tsx',
	'packages/worker/universal/blog-display.ts',
])

// Main still handles package-app origin isolation and inline serving before
// the APP_SURFACE forward (see packages/worker/src/index.ts).
const appSurfaceOnlyPathExclusions = new Set([
	'packages/worker/src/app/handlers/package-app.ts',
])

export type ProductionDeployTargets = {
	deployAppSurface: boolean
	deployMain: boolean
	deployRuntime: boolean
	deployJobs: boolean
}

export function isAppSurfaceOnlyPath(path: string) {
	if (appSurfaceOnlyPathExclusions.has(path)) return false
	if (appSurfaceOnlyExactPaths.has(path)) return true
	return appSurfaceOnlyPathPrefixes.some((prefix) => path.startsWith(prefix))
}

export function classifyProductionDeployPaths(
	paths: ReadonlyArray<string>,
): ProductionDeployTargets {
	const changed = paths.filter((path) => path.length > 0)
	if (changed.length === 0) {
		return {
			deployAppSurface: true,
			deployMain: true,
			deployRuntime: true,
			deployJobs: true,
		}
	}
	const appSurfaceOnly = changed.every((path) => isAppSurfaceOnlyPath(path))
	if (appSurfaceOnly) {
		return {
			deployAppSurface: true,
			deployMain: false,
			deployRuntime: false,
			deployJobs: false,
		}
	}
	return {
		deployAppSurface: true,
		deployMain: true,
		deployRuntime: true,
		deployJobs: true,
	}
}

export function formatGitHubDeployOutputs(targets: ProductionDeployTargets) {
	return [
		`deploy_app_surface=${targets.deployAppSurface}`,
		`deploy_main=${targets.deployMain}`,
		`deploy_runtime=${targets.deployRuntime}`,
		`deploy_jobs=${targets.deployJobs}`,
	].join('\n')
}

async function readStdinPaths() {
	const chunks: Array<string> = []
	for await (const chunk of process.stdin) {
		chunks.push(String(chunk))
	}
	return chunks
		.join('')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
}

export async function main() {
	const paths = await readStdinPaths()
	process.stdout.write(
		`${formatGitHubDeployOutputs(classifyProductionDeployPaths(paths))}\n`,
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
