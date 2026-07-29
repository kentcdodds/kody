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
			source: `import type { StaticInput } from 'kody:@kentcdodds/static-contract'

export default async function run() {
	const input: StaticInput = { name: 123 }
	return input
}`,
			packages,
		}),
	).rejects.toThrow("Type 'number' is not assignable to type 'string'")

	const transitivePackages = createLoadedPackages(`
import type { SharedInput } from 'kody:@kentcdodds/shared-types'
export default function call(input: SharedInput): Promise<number>
`)
	const primaryPackage = transitivePackages.get('@kentcdodds/static-contract')!
	transitivePackages.set('@kentcdodds/shared-types', {
		...primaryPackage,
		row: {
			...primaryPackage.row,
			id: 'package-2',
			name: '@kentcdodds/shared-types',
			kodyId: 'shared-types',
			sourceId: 'source-2',
		},
		source: {
			...primaryPackage.source,
			id: 'source-2',
			entity_id: 'package-2',
			repo_name: 'shared-types',
		},
		manifest: {
			name: '@kentcdodds/shared-types',
			exports: {
				'.': {
					import: './src/index.ts',
					types: './types/index.d.ts',
				},
			},
			kody: {
				id: 'shared-types',
				description: 'Shared types fixture',
			},
		},
		files: {
			'src/index.ts': 'export {}',
			'types/index.d.ts': 'export type SharedInput = { count: number }',
		},
	})
	await expect(
		assertAdHocExecuteTypechecks({
			source: `import call from 'kody:@kentcdodds/static-contract'
export default async function run() {
	return await call({ count: 'not-a-number' })
}`,
			packages: transitivePackages,
		}),
	).rejects.toThrow("Type 'string' is not assignable to type 'number'")

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

	await expect(
		assertAdHocExecuteTypechecks({
			source: `import call from 'kody:@kentcdodds/static-contract'
export default async function run() {
	return await call({ name: 7 })
}`,
			packages: createLoadedPackages('', {
				omitTypesTarget: true,
				runtimeSource:
					'export default async function call(input: { name: number }): Promise<number> { return input.name }',
			}),
		}),
	).resolves.toBeUndefined()
})

test('ad hoc execute typecheck rejects oversized source before loading the compiler', async () => {
	await expect(
		assertAdHocExecuteTypechecks({
			source: `export default function run() {}\n/*${'x'.repeat(512 * 1024)}*/`,
			packages: new Map() as LoadedKodyGraphPackages,
		}),
	).rejects.toThrow(
		'entry.ts exceeds the 524288-byte pre-execution TypeScript source limit.',
	)

	const packages = createLoadedPackages(stringContract)
	const loaded = packages.get('@kentcdodds/static-contract')!
	for (let index = 0; index < 500; index += 1) {
		loaded.files[`src/generated-${index}.ts`] = 'export {}'
	}
	await expect(
		assertAdHocExecuteTypechecks({
			source: 'export default function run() {}',
			packages,
		}),
	).rejects.toThrow(
		'Published Kody package types exceed the pre-execution TypeScript graph limit (500 files or 5242880 bytes).',
	)
})

test('ad hoc execute typecheck bounds concurrent active and queued checks', async () => {
	const checks = Array.from({ length: 5 }, () =>
		assertAdHocExecuteTypechecks({
			source: 'export default function run() { return "ok" }',
			packages: new Map() as LoadedKodyGraphPackages,
		}),
	)
	const results = await Promise.allSettled(checks)

	expect(
		results.filter((result) => result.status === 'fulfilled'),
	).toHaveLength(4)
	const rejected = results.filter((result) => result.status === 'rejected')
	expect(rejected).toHaveLength(1)
	expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
		name: 'ExecuteTypecheckError',
		message: expect.stringContaining('already has 4 active or queued requests'),
	})
})
