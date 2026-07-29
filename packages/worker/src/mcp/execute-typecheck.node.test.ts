import { expect, test } from 'vitest'
import { type LoadedKodyGraphPackages } from '#worker/package-runtime/module-graph-import-rewriting.ts'
import {
	assertAdHocExecuteTypechecks,
	ExecuteTypecheckError,
} from './execute-typecheck.ts'

function createLoadedPackages(
	typeSource: string,
	options?: { runtimeSource?: string; omitTypesTarget?: boolean },
) {
	return new Map([
		[
			'@kentcdodds/static-contract',
			{
				row: {
					id: 'package-1',
					userId: 'user-1',
					name: '@kentcdodds/static-contract',
					kodyId: 'static-contract',
					description: 'Static contract fixture',
					tags: [],
					searchText: null,
					sourceId: 'source-1',
					hasApp: false,
					hidden: false,
					isPrivate: true,
					createdAt: '2026-07-29T00:00:00.000Z',
					updatedAt: '2026-07-29T00:00:00.000Z',
				},
				source: {
					id: 'source-1',
					user_id: 'user-1',
					entity_type: 'package',
					entity_id: 'package-1',
					manifest_path: 'package.json',
					source_root: '',
					repo_provider: 'github',
					repo_owner: 'kentcdodds',
					repo_name: 'static-contract',
					repo_url: 'https://github.com/kentcdodds/static-contract',
					default_branch: 'main',
					published_commit: 'commit-1',
					created_at: '2026-07-29T00:00:00.000Z',
					updated_at: '2026-07-29T00:00:00.000Z',
				},
				manifest: {
					name: '@kentcdodds/static-contract',
					exports: {
						'.': options?.omitTypesTarget
							? './src/index.ts'
							: {
									import: './src/index.ts',
									types: './types/index.d.ts',
								},
					},
					kody: {
						id: 'static-contract',
						description: 'Static contract fixture',
					},
				},
				files: {
					'src/index.ts':
						options?.runtimeSource ??
						'export default async function call(input: unknown): Promise<unknown> { return input }',
					'types/index.d.ts': typeSource,
				},
				prefix: 'unused-by-typecheck',
			},
		],
	]) as unknown as LoadedKodyGraphPackages
}

const stringContract = `
export type StaticInput = { name: string }
export type StaticResult = { message: string }
export default function call(input: StaticInput): Promise<StaticResult>
`

test('ad hoc execute typecheck uses published package declarations and reports original source locations', async () => {
	const packages = createLoadedPackages(stringContract)

	await expect(
		assertAdHocExecuteTypechecks({
			source: `import call from 'kody:@kentcdodds/static-contract'

export default async function run() {
	const result: number = await call({ name: 123 })
	return result
}`,
			packages,
		}),
	).rejects.toSatisfy((error: unknown) => {
		expect(error).toBeInstanceOf(ExecuteTypecheckError)
		expect(error).toMatchObject({
			name: 'ExecuteTypecheckError',
			diagnostics: expect.arrayContaining([
				expect.stringMatching(/^entry\.ts:4:\d+ TS2322:/),
			]),
		})
		expect((error as Error).message).toContain(
			'Ad hoc execute TypeScript check failed:',
		)
		expect((error as Error).message).toContain(
			"Type 'number' is not assignable to type 'string'",
		)
		expect((error as Error).message).toContain(
			"Type 'StaticResult' is not assignable to type 'number'",
		)
		return true
	})

	await expect(
		assertAdHocExecuteTypechecks({
			source: `import call from 'kody:@kentcdodds/static-contract'
import { kody, packageStorage } from 'kody:runtime'
import arbitraryClient from 'arbitrary-uninstalled-npm-package'

export default async function run() {
	void arbitraryClient
	void kody
	void packageStorage
	const result = await call({ name: 'Ada' })
	return result.message
}`,
			packages,
		}),
	).resolves.toBeUndefined()
})

test('warm typecheck service replaces package sources between requests', async () => {
	await expect(
		assertAdHocExecuteTypechecks({
			source: `import call from 'kody:@kentcdodds/static-contract'
export default async function run() {
	return await call({ name: 42 })
}`,
			packages: createLoadedPackages('', {
				omitTypesTarget: true,
				runtimeSource:
					'export default async function call(input: { name: number }): Promise<number> { return input.name }',
			}),
		}),
	).resolves.toBeUndefined()

	await expect(
		assertAdHocExecuteTypechecks({
			source: `import call from 'kody:@kentcdodds/static-contract'
export default async function run() {
	return await call({ name: 'Grace' })
}`,
			packages: createLoadedPackages(stringContract),
		}),
	).resolves.toBeUndefined()
})
