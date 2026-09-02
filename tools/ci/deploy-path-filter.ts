import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * Production deploy path classification:
 * - Remix/blog/UI-only → origin; skip platform/runtime/jobs/highlight
 * - Official guide markdown (also bundled into the MCP Durable Object) →
 *   origin + platform; skip runtime/jobs/highlight
 * - Highlight worker or shared highlight types → highlight (plus origin when
 *   origin also imports those types)
 * - Jobs worker or shared jobs modules → jobs (plus origin when origin also
 *   imports those modules)
 * - Backup/DR control plane, contributing docs, and usage docs → no app
 *   workers (the backup plane has its own workflow job)
 * - Shared backup modules → origin (origin parses full backup manifests)
 * - Deploy workflow itself → all five scripts
 * - Anything else → origin + platform + runtime, plus jobs/highlight only
 *   when their sources or shared deps change
 */

const originOnlyPathPrefixes = [
	'packages/worker/client/',
	'packages/worker/public/',
	'packages/worker/src/blog/posts/',
	'packages/worker/src/app/',
	'packages/worker/src/mcp/',
	'packages/worker/src/origin-handler',
	'packages/worker/universal/styles/',
	'packages/shared/src/backup-',
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
const highlightSharedPathPrefixes = [
	'packages/worker/universal/highlight-',
	'packages/worker/universal/highlighted-code',
] as const

const jobsWorkerPathPrefix = 'packages/jobs-worker/'
const jobsWorkerResourcesPathPrefix = 'tools/ci/jobs-worker-resources'
const jobsSharedPathPrefix = 'packages/shared/src/jobs/'
const jobsSharedExactPaths = new Set([
	'packages/shared/src/d1-retry.ts',
	'packages/shared/src/chat.ts',
])

const platformPathPrefixes = [
	'packages/platform-worker/',
	'packages/worker/src/platform-worker',
	'packages/shared/src/platform-worker',
	'tools/ci/platform-worker-config',
] as const

const runtimePathPrefixes = [
	'packages/runtime-worker/',
	'packages/worker/src/runtime-worker',
	'packages/shared/src/runtime-worker',
	'tools/ci/runtime-worker-config',
] as const

const skipAppWorkerPathPrefixes = [
	'packages/backup-control-plane/',
	'tools/disaster-recovery/',
	'tools/ci/backup-resources',
	'docs/contributing/',
	'docs/use/',
] as const

const allWorkersExactPaths = new Set(['.github/workflows/deploy.yml'])

export type ProductionDeployTargets = {
	deployMain: boolean
	deployPlatform: boolean
	deployRuntime: boolean
	deployJobs: boolean
	deployHighlight: boolean
}

type DeployScript = 'origin' | 'platform' | 'runtime' | 'jobs' | 'highlight'

type PathClass =
	| { kind: 'skip' }
	| { kind: 'all' }
	| { kind: 'unknown' }
	| { kind: 'scripts'; scripts: ReadonlyArray<DeployScript> }

const allWorkers = {
	deployMain: true,
	deployPlatform: true,
	deployRuntime: true,
	deployJobs: true,
	deployHighlight: true,
} as const satisfies ProductionDeployTargets

const noWorkers = {
	deployMain: false,
	deployPlatform: false,
	deployRuntime: false,
	deployJobs: false,
	deployHighlight: false,
} as const satisfies ProductionDeployTargets

const unknownFallback = {
	deployMain: true,
	deployPlatform: true,
	deployRuntime: true,
	deployJobs: false,
	deployHighlight: false,
} as const satisfies ProductionDeployTargets

function startsWithAny(path: string, prefixes: ReadonlyArray<string>): boolean {
	return prefixes.some((prefix) => path.startsWith(prefix))
}

export function isOriginOnlyPath(path: string) {
	if (originOnlyPathExclusions.has(path)) return false
	if (originOnlyExactPaths.has(path)) return true
	return startsWithAny(path, originOnlyPathPrefixes)
}

export function isOriginAndPlatformPath(path: string) {
	return startsWithAny(path, originAndPlatformPathPrefixes)
}

export function isHighlightWorkerPath(path: string) {
	return path.startsWith(highlightWorkerPathPrefix)
}

export function isHighlightSharedPath(path: string) {
	return startsWithAny(path, highlightSharedPathPrefixes)
}

export function isJobsWorkerPath(path: string) {
	return (
		path.startsWith(jobsWorkerPathPrefix) ||
		path.startsWith(jobsWorkerResourcesPathPrefix)
	)
}

export function isJobsSharedPath(path: string) {
	return path.startsWith(jobsSharedPathPrefix) || jobsSharedExactPaths.has(path)
}

export function isPlatformPath(path: string) {
	return startsWithAny(path, platformPathPrefixes)
}

export function isRuntimePath(path: string) {
	return startsWithAny(path, runtimePathPrefixes)
}

export function isSkipAppWorkerPath(path: string) {
	if (isOriginAndPlatformPath(path)) return false
	return startsWithAny(path, skipAppWorkerPathPrefixes)
}

function classifyPath(path: string): PathClass {
	if (allWorkersExactPaths.has(path)) return { kind: 'all' }
	if (isSkipAppWorkerPath(path)) return { kind: 'skip' }

	const scripts = new Set<DeployScript>()
	if (isHighlightWorkerPath(path) || isHighlightSharedPath(path)) {
		scripts.add('highlight')
	}
	if (isJobsWorkerPath(path) || isJobsSharedPath(path)) {
		scripts.add('jobs')
	}
	if (isPlatformPath(path) || isOriginAndPlatformPath(path)) {
		scripts.add('platform')
	}
	if (isRuntimePath(path)) {
		scripts.add('runtime')
	}
	if (
		isOriginOnlyPath(path) ||
		isOriginAndPlatformPath(path) ||
		isHighlightSharedPath(path) ||
		isJobsSharedPath(path)
	) {
		scripts.add('origin')
	}

	if (scripts.size > 0) return { kind: 'scripts', scripts: [...scripts] }
	return { kind: 'unknown' }
}

function targetsFromScripts(
	scripts: ReadonlySet<DeployScript>,
): ProductionDeployTargets {
	return {
		deployMain: scripts.has('origin'),
		deployPlatform: scripts.has('platform'),
		deployRuntime: scripts.has('runtime'),
		deployJobs: scripts.has('jobs'),
		deployHighlight: scripts.has('highlight'),
	}
}

export function classifyProductionDeployPaths(
	paths: ReadonlyArray<string>,
): ProductionDeployTargets {
	const changed = paths.filter((path) => path.length > 0)
	if (changed.length === 0) return { ...allWorkers }

	const scripts = new Set<DeployScript>()
	let sawUnknown = false
	let sawClassified = false

	for (const path of changed) {
		const classified = classifyPath(path)
		switch (classified.kind) {
			case 'skip':
				break
			case 'all':
				return { ...allWorkers }
			case 'unknown':
				sawUnknown = true
				sawClassified = true
				break
			case 'scripts':
				sawClassified = true
				for (const script of classified.scripts) scripts.add(script)
				break
			default: {
				const exhaustive: never = classified
				throw new Error(
					`Unhandled deploy path class: ${JSON.stringify(exhaustive)}`,
				)
			}
		}
	}

	if (!sawClassified) return { ...noWorkers }
	if (sawUnknown) {
		return {
			...unknownFallback,
			deployJobs: scripts.has('jobs'),
			deployHighlight: scripts.has('highlight'),
		}
	}
	return targetsFromScripts(scripts)
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
