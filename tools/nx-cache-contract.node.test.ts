import { readFile } from 'node:fs/promises'
import {
	hashArray,
	type FileData,
	type NxJsonConfiguration,
	type ProjectConfiguration,
	type ProjectGraphProjectNode,
} from 'nx/src/devkit-exports.js'
import {
	filterUsingGlobPatterns,
	getTargetInputs,
} from 'nx/src/hasher/task-hasher.js'
import { expect, test } from 'vitest'

async function readJson<T>(filename: string): Promise<T> {
	return JSON.parse(await readFile(filename, 'utf8')) as T
}

async function getWorkerTargetPatterns(target: string): Promise<Array<string>> {
	const [nxJson, worker] = await Promise.all([
		readJson<NxJsonConfiguration>('nx.json'),
		readJson<ProjectConfiguration>('packages/worker/project.json'),
	])
	const projectNode: ProjectGraphProjectNode = {
		name: 'worker',
		type: 'app',
		data: worker,
	}
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
