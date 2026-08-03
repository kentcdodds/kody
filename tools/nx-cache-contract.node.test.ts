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

async function getWorkerTargetPatterns(target: string): Promise<Array<string>> {
	// Nx 23 merges `nx.json` targetDefaults onto project targets during graph
	// construction. `getTargetInputs` no longer re-reads targetDefaults itself,
	// so the contract must use the graph-merged target config.
	const [nxJson, projectGraph] = await Promise.all([
		readJsonFile<NxJsonConfiguration>('nx.json'),
		createProjectGraphAsync(),
	])
	const projectNode = projectGraph.nodes['worker'] as ProjectGraphProjectNode
	return getTargetInputs(nxJson, projectNode, target).selfInputs
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

test.each([
	{
		target: 'test',
		requiredInput: '{workspaceRoot}/packages/mock-servers/cloudflare/**/*',
		dependencyFile: 'packages/mock-servers/cloudflare/src/index.ts',
	},
	{
		target: 'test-mcp',
		requiredInput: '{workspaceRoot}/wrangler-env.ts',
		dependencyFile: 'wrangler-env.ts',
	},
])(
	'$target cache hash includes $dependencyFile',
	async ({ target, requiredInput, dependencyFile }) => {
		const patterns = await getWorkerTargetPatterns(target)
		expect(patterns).toContain(requiredInput)

		const before = hashMatchedInputs(patterns, [
			{ file: dependencyFile, hash: 'before' },
		])
		const after = hashMatchedInputs(patterns, [
			{ file: dependencyFile, hash: 'after' },
		])
		expect(after).not.toBe(before)
	},
)
