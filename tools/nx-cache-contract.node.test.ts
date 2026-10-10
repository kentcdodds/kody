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

async function getWorkerProjectNode() {
	const projectGraph = await createProjectGraphAsync()
	return projectGraph.nodes['worker'] as ProjectGraphProjectNode
}

async function getWorkerTargetPatterns(target: string): Promise<Array<string>> {
	// Nx 23 merges `nx.json` targetDefaults onto project targets during graph
	// construction. `getTargetInputs` no longer re-reads targetDefaults itself,
	// so the contract must use the graph-merged target config.
	const [nxJson, projectNode] = await Promise.all([
		readJsonFile<NxJsonConfiguration>('nx.json'),
		getWorkerProjectNode(),
	])
	return getTargetInputs(nxJson, projectNode, target).selfInputs.filter(
		(input): input is string => typeof input === 'string',
	)
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
): string {
	const workspacePatterns = patterns.map((pattern) =>
		pattern.replace('{workspaceRoot}/', ''),
	)
	const matchedFiles = filterUsingGlobPatterns(
		'packages/worker',
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

test.each(['test', 'test-node', 'test-workers', 'test-mcp', 'test-e2e'])(
	'%s cache hash includes CI so local validate matches GitHub Actions',
	async (target) => {
		const inputs = await getWorkerDeclaredInputs(target)
		expect(includesCiEnv(inputs)).toBe(true)
	},
)

test('test cache hash includes KODY_VALIDATE_LOAD because the full suite runs workers-unit', async () => {
	const inputs = await getWorkerDeclaredInputs('test')
	expect(includesEnvInput(inputs, 'KODY_VALIDATE_LOAD')).toBe(true)
})

test('test-workers cache hash includes KODY_VALIDATE_LOAD for validate-load timeouts', async () => {
	const inputs = await getWorkerDeclaredInputs('test-workers')
	expect(includesEnvInput(inputs, 'KODY_VALIDATE_LOAD')).toBe(true)
})
