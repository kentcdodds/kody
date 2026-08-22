import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * Production deploy path classification: content/UI-only changes deploy the
 * origin Worker and skip the Durable Object–owning platform/runtime/jobs
 * scripts.
 */

const originOnlyPathPrefixes = [
	'docs/guides/',
	'packages/worker/client/',
	'packages/worker/public/',
	'packages/worker/src/blog/posts/',
	'packages/worker/src/app/handlers/',
	'packages/worker/src/app/ssr-stubs/',
	'packages/worker/universal/styles/',
] as const

const originOnlyExactPaths = new Set([
	'packages/worker/src/app/layout.ts',
	'packages/worker/src/app/ssr-render.tsx',
	'packages/worker/universal/blog-display.ts',
])

// Origin still handles package-app origin isolation and inline serving
// before the runtime forward (see packages/worker/src/index.ts).
const originOnlyPathExclusions = new Set([
	'packages/worker/src/app/handlers/package-app.ts',
])

export type ProductionDeployTargets = {
	deployMain: boolean
	deployPlatform: boolean
	deployRuntime: boolean
	deployJobs: boolean
}

export function isOriginOnlyPath(path: string) {
	if (originOnlyPathExclusions.has(path)) return false
	if (originOnlyExactPaths.has(path)) return true
	return originOnlyPathPrefixes.some((prefix) => path.startsWith(prefix))
}

export function classifyProductionDeployPaths(
	paths: ReadonlyArray<string>,
): ProductionDeployTargets {
	const changed = paths.filter((path) => path.length > 0)
	if (changed.length === 0) {
		return {
			deployMain: true,
			deployPlatform: true,
			deployRuntime: true,
			deployJobs: true,
		}
	}
	const originOnly = changed.every((path) => isOriginOnlyPath(path))
	if (originOnly) {
		return {
			deployMain: true,
			deployPlatform: false,
			deployRuntime: false,
			deployJobs: false,
		}
	}
	return {
		deployMain: true,
		deployPlatform: true,
		deployRuntime: true,
		deployJobs: true,
	}
}

export function formatGitHubDeployOutputs(targets: ProductionDeployTargets) {
	return [
		`deploy_main=${targets.deployMain}`,
		`deploy_platform=${targets.deployPlatform}`,
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
