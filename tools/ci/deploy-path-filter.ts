import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * Production deploy path classification:
 * - Remix/blog/UI-only → origin; skip platform/runtime/jobs/highlight
 * - Official guide markdown (also bundled into the MCP Durable Object) →
 *   origin + platform; skip runtime/jobs/highlight
 * - Highlight worker only → highlight
 * - Origin + highlight → origin + highlight
 * - Backup control plane / DR tooling / contributing docs → none of the
 *   five fleet scripts (the backup-control-plane job has its own path
 *   filter in deploy.yml and uses DR_DEPLOY_TOKEN)
 * - Shared backup modules (origin mailbox/DR export parsers) → origin
 * - Anything else → all five scripts
 */

const originOnlyPathPrefixes = [
	'packages/worker/client/',
	'packages/worker/public/',
	'packages/worker/src/blog/posts/',
	'packages/worker/src/app/handlers/',
	'packages/worker/src/app/ssr-stubs/',
	'packages/worker/universal/styles/',
] as const

const originAndPlatformPathPrefixes = [
	'docs/guides/',
	'packages/worker/src/guides/',
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

const highlightWorkerPathPrefix = 'packages/highlight-worker/'

// Independently deployed DR control plane, its CLI/provisioners, and
// contributing docs. None of these are bundled into the production fleet.
const skipFleetPathPrefixes = [
	'packages/backup-control-plane/',
	'tools/disaster-recovery/',
	'tools/ci/backup-resources',
	'docs/contributing/',
] as const

// Origin parses full backup manifests for mailbox import and DR export
// staging. Highlight/jobs/platform/runtime do not import these modules.
const sharedBackupPathPrefix = 'packages/shared/src/backup-'

export type ProductionDeployTargets = {
	deployMain: boolean
	deployPlatform: boolean
	deployRuntime: boolean
	deployJobs: boolean
	deployHighlight: boolean
}

export function isOriginOnlyPath(path: string) {
	if (originOnlyPathExclusions.has(path)) return false
	if (isSharedBackupPath(path)) return true
	if (originOnlyExactPaths.has(path)) return true
	return originOnlyPathPrefixes.some((prefix) => path.startsWith(prefix))
}

export function isOriginAndPlatformPath(path: string) {
	return originAndPlatformPathPrefixes.some((prefix) => path.startsWith(prefix))
}

export function isHighlightWorkerPath(path: string) {
	return path.startsWith(highlightWorkerPathPrefix)
}

export function isSkipFleetPath(path: string) {
	return skipFleetPathPrefixes.some((prefix) => path.startsWith(prefix))
}

export function isSharedBackupPath(path: string) {
	return path.startsWith(sharedBackupPathPrefix)
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
			deployHighlight: true,
		}
	}
	const fleetPaths = changed.filter((path) => !isSkipFleetPath(path))
	if (fleetPaths.length === 0) {
		return {
			deployMain: false,
			deployPlatform: false,
			deployRuntime: false,
			deployJobs: false,
			deployHighlight: false,
		}
	}
	if (fleetPaths.every((path) => isHighlightWorkerPath(path))) {
		return {
			deployMain: false,
			deployPlatform: false,
			deployRuntime: false,
			deployJobs: false,
			deployHighlight: true,
		}
	}
	if (fleetPaths.every((path) => isOriginOnlyPath(path))) {
		return {
			deployMain: true,
			deployPlatform: false,
			deployRuntime: false,
			deployJobs: false,
			deployHighlight: false,
		}
	}
	if (
		fleetPaths.every(
			(path) => isOriginOnlyPath(path) || isHighlightWorkerPath(path),
		)
	) {
		return {
			deployMain: true,
			deployPlatform: false,
			deployRuntime: false,
			deployJobs: false,
			deployHighlight: true,
		}
	}
	if (
		fleetPaths.every(
			(path) => isOriginOnlyPath(path) || isOriginAndPlatformPath(path),
		)
	) {
		return {
			deployMain: true,
			deployPlatform: true,
			deployRuntime: false,
			deployJobs: false,
			deployHighlight: false,
		}
	}
	return {
		deployMain: true,
		deployPlatform: true,
		deployRuntime: true,
		deployJobs: true,
		deployHighlight: true,
	}
}

export function formatGitHubDeployOutputs(targets: ProductionDeployTargets) {
	return [
		`deploy_main=${targets.deployMain}`,
		`deploy_platform=${targets.deployPlatform}`,
		`deploy_runtime=${targets.deployRuntime}`,
		`deploy_jobs=${targets.deployJobs}`,
		`deploy_highlight=${targets.deployHighlight}`,
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
