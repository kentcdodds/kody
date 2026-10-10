import {
	createProjectGraphAsync,
	hashArray,
	type FileData,
	type NxJsonConfiguration,
	type ProjectGraphProjectNode,
	readJsonFile,
} from 'nx/src/devkit-exports.js'
import {
	filterUsingGlobPatterns,
	getTargetInputs,
} from 'nx/src/hasher/task-hasher.js'
import { expect, test } from 'vitest'

async function getProjectNode(project: string) {
	const projectGraph = await createProjectGraphAsync()
	return projectGraph.nodes[project] as ProjectGraphProjectNode
}

async function getWorkerProjectNode() {
	return getProjectNode('worker')
}

async function getTargetPatterns(
	project: string,
	target: string,
): Promise<Array<string>> {
	// Nx 23 merges `nx.json` targetDefaults onto project targets during graph
	// construction. `getTargetInputs` no longer re-reads targetDefaults itself,
	// so the contract must use the graph-merged target config.
	const [nxJson, projectNode] = await Promise.all([
		readJsonFile<NxJsonConfiguration>('nx.json'),
		getProjectNode(project),
	])
	return getTargetInputs(nxJson, projectNode, target).selfInputs.filter(
		(input): input is string => typeof input === 'string',
	)
}

async function getWorkerTargetPatterns(target: string): Promise<Array<string>> {
	return getTargetPatterns('worker', target)
}

function expandNamedInputs(
	inputs: ReadonlyArray<unknown>,
	namedInputs: NxJsonConfiguration['namedInputs'],
): Array<unknown> {
	return inputs.flatMap((input) => {
		const named = typeof input === 'string' ? namedInputs?.[input] : undefined
		return named ? expandNamedInputs(named, namedInputs) : [input]
	})
}

async function getWorkerDeclaredInputs(target: string) {
	const [nxJson, projectNode] = await Promise.all([
		readJsonFile<NxJsonConfiguration>('nx.json'),
		getWorkerProjectNode(),
	])
	return expandNamedInputs(
		projectNode.data.targets?.[target]?.inputs ?? [],
		nxJson.namedInputs,
	)
}

function includesEnvInput(inputs: ReadonlyArray<unknown>, envName: string) {
	const marker = `{env:${envName}}`
	return inputs.some((input) => {
		if (input === marker) return true
		return (
			typeof input === 'object' &&
			input !== null &&
			'env' in input &&
			(input as { env?: unknown }).env === envName
		)
	})
}

function includesCiEnv(inputs: ReadonlyArray<unknown>) {
	return includesEnvInput(inputs, 'CI')
}

function hashMatchedInputs(
	patterns: ReadonlyArray<string>,
	files: ReadonlyArray<FileData>,
	projectRoot = 'packages/worker',
): string {
	const workspacePatterns = patterns.map((pattern) =>
		pattern.replace('{workspaceRoot}/', ''),
	)
	const matchedFiles = filterUsingGlobPatterns(
		projectRoot,
		[...files],
		workspacePatterns,
	)
	return hashArray(
		matchedFiles
			.sort((left, right) => left.file.localeCompare(right.file))
			.map(({ file, hash }) => `${file}:${hash}`),
	)
}

// Every file a suite can read at run time must move its cache hash. node-unit
// collects `**/*.node.test.ts` repo-wide and tools tests read docs/ and
// .agents/; the worker bundles docs/guides, jobs-worker and highlight-worker
// into the suites; vite.config.ts and wrangler-env.ts shape the e2e/MCP
// servers. A pattern list that misses any of these replays a stale result.
const cloudflareMock = 'packages/mock-servers/cloudflare/src/index.ts'
const suiteDependencyFiles: Record<string, ReadonlyArray<string>> = {
	test: [
		cloudflareMock,
		'docs/guides/secrets.md',
		'packages/status/x.node.test.ts',
	],
	'test-node': [
		cloudflareMock,
		'docs/guides/secrets.md',
		'docs/contributing/index.md',
		'.agents/skills/ship-pr/SKILL.md',
		'packages/status/x.node.test.ts',
		'packages/backup-control-plane/x.node.test.ts',
		'e2e/x.node.test.ts',
		'.github/workflows/validate.yml',
		'.cursor/rules/x.mdc',
		'.husky/pre-commit',
	],
	'test-workers': [
		cloudflareMock,
		'docs/guides/secrets.md',
		'packages/jobs-worker/src/index.ts',
		'packages/highlight-worker/src/index.ts',
		'packages/shared/src/x.ts',
		'wrangler-env.ts',
	],
	'test-e2e': [
		cloudflareMock,
		'docs/guides/secrets.md',
		'packages/jobs-worker/src/index.ts',
		'packages/highlight-worker/src/index.ts',
		'vite.config.ts',
		'tools/e2e-web-server.ts',
		'e2e/x.spec.ts',
		'playwright.config.ts',
	],
	'test-mcp': [
		cloudflareMock,
		'docs/guides/secrets.md',
		'packages/jobs-worker/src/index.ts',
		'vite.config.ts',
		'wrangler-env.ts',
		'tools/mcp-test-support.ts',
	],
	typecheck: [cloudflareMock],
	build: ['docs/guides/secrets.md', 'vite.config.ts', 'tools/x.ts'],
}

test.each(
	Object.entries(suiteDependencyFiles).flatMap(([target, files]) =>
		files.map((dependencyFile) => ({ target, dependencyFile })),
	),
)(
	'$target cache hash includes $dependencyFile',
	async ({ target, dependencyFile }) => {
		const patterns = await getWorkerTargetPatterns(target)

		const before = hashMatchedInputs(patterns, [
			{ file: dependencyFile, hash: 'before' },
		])
		const after = hashMatchedInputs(patterns, [
			{ file: dependencyFile, hash: 'after' },
		])
		expect(after).not.toBe(before)
	},
)

// `tools:typecheck` covers tsconfig-tools-typecheck.json: root TS files,
// tools/, e2e/, .agents/, and whatever they import from packages/. Docs,
// workflows, and editor policy never reach tsc, so they must not invalidate
// the cached result (every docs PR would otherwise re-run it).
const toolsTypecheckInputs = [
	'tools/x.ts',
	'e2e/x.ts',
	'.agents/skills/x/scripts/x.ts',
	'packages/shared/src/x.ts',
	'packages/worker/src/x.ts',
	'vitest.node.config.ts',
	'tsconfig-tools.json',
	'package.json',
]
const toolsTypecheckNonInputs = [
	'docs/contributing/index.md',
	'.github/workflows/validate.yml',
	'.cursor/rules/x.mdc',
]

function hashToolsTypecheckFile(
	patterns: ReadonlyArray<string>,
	file: string,
	hash: string,
) {
	return hashMatchedInputs(patterns, [{ file, hash }], '.')
}

test.each(toolsTypecheckInputs)(
	'tools:typecheck cache hash includes %s',
	async (file) => {
		const patterns = await getTargetPatterns('tools', 'typecheck')
		expect(hashToolsTypecheckFile(patterns, file, 'after')).not.toBe(
			hashToolsTypecheckFile(patterns, file, 'before'),
		)
	},
)

test.each(toolsTypecheckNonInputs)(
	'tools:typecheck cache hash ignores %s',
	async (file) => {
		const patterns = await getTargetPatterns('tools', 'typecheck')
		expect(hashToolsTypecheckFile(patterns, file, 'after')).toBe(
			hashToolsTypecheckFile(patterns, file, 'before'),
		)
	},
)

test.each(['test', 'test-node', 'test-workers', 'test-mcp', 'test-e2e'])(
	'%s cache hash includes CI so local validate matches GitHub Actions',
	async (target) => {
		const inputs = await getWorkerDeclaredInputs(target)
		expect(includesCiEnv(inputs)).toBe(true)
	},
)

test('cache hash includes KODY_VALIDATE_LOAD because the full suite runs workers-unit', async () => {
	const inputs = await getWorkerDeclaredInputs('test')
	expect(includesEnvInput(inputs, 'KODY_VALIDATE_LOAD')).toBe(true)
})

test('test-workers cache hash includes KODY_VALIDATE_LOAD for validate-load timeouts', async () => {
	const inputs = await getWorkerDeclaredInputs('test-workers')
	expect(includesEnvInput(inputs, 'KODY_VALIDATE_LOAD')).toBe(true)
})
