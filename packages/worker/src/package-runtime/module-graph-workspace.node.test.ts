import { expect, test } from 'vitest'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { resolveKodyDependenciesForEntryPoint } from './module-graph-workspace.ts'

function createLoadedPackage(input: {
	kodyId: string
	exports: Record<string, string>
	files: Record<string, string>
	ownerUserId?: string
	shareOwned?: boolean
}) {
	const ownerUserId = input.ownerUserId ?? 'user-1'
	const name = `@kentcdodds/${input.kodyId}`
	const packageId = `pkg-${input.kodyId}-${ownerUserId}`
	const sourceId = `source-${input.kodyId}-${ownerUserId}`
	return {
		row: {
			id: packageId,
			userId: ownerUserId,
			name,
			kodyId: input.kodyId,
			description: `${input.kodyId} package`,
			tags: [],
			searchText: null,
			sourceId,
			hasApp: false,
			hasSkills: false,
			hidden: false,
			isPrivate: true,
			lockedAt: null,
			createdAt: '2026-09-30T00:00:00.000Z',
			updatedAt: '2026-09-30T00:00:00.000Z',
		},
		source: {
			id: sourceId,
			user_id: ownerUserId,
			entity_kind: 'package' as const,
			entity_id: packageId,
			repo_id: `repo-${sourceId}`,
			published_commit: `commit-${sourceId}`,
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			last_external_check_at: null,
			external_check_until: null,
			created_at: '2026-09-30T00:00:00.000Z',
			updated_at: '2026-09-30T00:00:00.000Z',
		},
		manifest: parseAuthoredPackageJson({
			content: JSON.stringify({
				name,
				exports: input.exports,
				kody: { id: input.kodyId, description: `${input.kodyId} package` },
			}),
		}),
		files: input.files,
		prefix: `.__kody_packages__/${name}`,
		sourceOwnerUserId: ownerUserId,
		platformScope: null,
		...(input.shareOwned
			? { shareOwned: true, storageOwnerUserId: ownerUserId }
			: {}),
	}
}

function resolveDependencies(input: {
	entrySource: string
	loadedPackages: Map<string, ReturnType<typeof createLoadedPackage>>
}) {
	return resolveKodyDependenciesForEntryPoint({
		env: {} as Env,
		baseUrl: 'https://kody.dev',
		userId: 'user-1',
		sourceFiles: { 'entry.ts': input.entrySource },
		entryPoint: 'entry.ts',
		loadedPackages: input.loadedPackages,
	})
}

const wake = createLoadedPackage({
	kodyId: 'wake',
	exports: { './whoami': './src/whoami.ts' },
	files: {
		'src/whoami.ts': 'export default async function whoami() { return 1 }',
	},
})

test('every imported export of a dependency seeds the transitive walk', async () => {
	const relay = createLoadedPackage({
		kodyId: 'relay',
		exports: { './a-run': './src/a-run.ts', './z-ping': './src/z-ping.ts' },
		files: {
			'src/a-run.ts': `import whoami from 'kody:@kentcdodds/wake/whoami'
export default async function run() { return await whoami() }`,
			'src/z-ping.ts': 'export default async function ping() { return 1 }',
		},
	})
	const dependencies = await resolveDependencies({
		entrySource: `import run from 'kody:@kentcdodds/relay/a-run'
import ping from 'kody:@kentcdodds/relay/z-ping'
export default async function main() { return [await run(), await ping()] }`,
		loadedPackages: new Map([
			['@kentcdodds/relay', relay],
			['@kentcdodds/wake', wake],
		]),
	})
	expect(dependencies).toEqual([
		expect.objectContaining({ packageId: relay.row.id }),
		expect.objectContaining({ packageId: wake.row.id, transitive: true }),
	])
	expect(dependencies[0]).not.toHaveProperty('transitive')
})

test('a package imported directly and transitively stays a direct dependency', async () => {
	const relay = createLoadedPackage({
		kodyId: 'relay',
		exports: { './run': './src/run.ts' },
		files: {
			'src/run.ts': `import whoami from 'kody:@kentcdodds/wake/whoami'
export default async function run() { return await whoami() }`,
		},
	})
	const dependencies = await resolveDependencies({
		entrySource: `import run from 'kody:@kentcdodds/relay/run'
import whoami from 'kody:@kentcdodds/wake/whoami'
export default async function main() { return [await run(), await whoami()] }`,
		loadedPackages: new Map([
			['@kentcdodds/relay', relay],
			['@kentcdodds/wake', wake],
		]),
	})
	expect(dependencies.map((dependency) => dependency.packageId)).toEqual([
		relay.row.id,
		wake.row.id,
	])
	expect(dependencies.some((dependency) => dependency.transitive)).toBe(false)
})

test('imports inside a share-owned package resolve under the share owner', async () => {
	const shared = createLoadedPackage({
		kodyId: 'shared',
		ownerUserId: 'owner-1',
		shareOwned: true,
		exports: { './run': './src/run.ts' },
		files: {
			'src/run.ts': `import whoami from 'kody:@kentcdodds/wake/whoami'
export default async function run() { return await whoami() }`,
		},
	})
	const ownerWake = createLoadedPackage({
		kodyId: 'wake',
		ownerUserId: 'owner-1',
		shareOwned: true,
		exports: { './whoami': './src/whoami.ts' },
		files: {
			'src/whoami.ts': 'export default async function whoami() { return 2 }',
		},
	})
	const dependencies = await resolveDependencies({
		entrySource: `import run from 'kody:@kentcdodds/shared/run'
export default async function main() { return await run() }`,
		loadedPackages: new Map([
			['@kentcdodds/shared', shared],
			['@kentcdodds/wake', wake],
			['@kentcdodds/wake#owner-1', ownerWake],
		]),
	})
	expect(dependencies).toEqual([
		expect.objectContaining({ packageId: shared.row.id, shareOwned: true }),
		expect.objectContaining({
			packageId: ownerWake.row.id,
			transitive: true,
			shareOwned: true,
			storageOwnerUserId: 'owner-1',
		}),
	])
})
