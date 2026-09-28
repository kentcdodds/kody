import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	listSavedPackagesWithCommunityProvenanceByUserId: vi.fn(),
	getSavedPackageWithCommunityProvenanceById: vi.fn(),
	listAcceptedInboundSharedPackages: vi.fn(),
	listPlatformPackagesForSearch: vi.fn(async () => []),
}))

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: async () => ({ capabilitySpecs: {} }),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	listUserSecretsForSearch: async () => [],
}))

vi.mock('#worker/integrations/service.ts', () => ({
	listJoinedIntegrations: async () => [],
}))

vi.mock('#worker/package-registry/platform-packages.ts', () => ({
	listPlatformPackagesForSearch: (...args: Array<unknown>) =>
		mockModule.listPlatformPackagesForSearch(...(args as [])),
}))

vi.mock('#worker/community/fork-listing-relation.ts', () => ({
	applySavedPackageForkListingAncestry: async ({
		records,
	}: {
		records: Array<unknown>
	}) => records,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesWithCommunityProvenanceByUserId: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesWithCommunityProvenanceByUserId(...args),
	getSavedPackageWithCommunityProvenanceById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageWithCommunityProvenanceById(...args),
}))

vi.mock('#worker/package-registry/share-grants.ts', () => ({
	listAcceptedInboundSharedPackages: (...args: Array<unknown>) =>
		mockModule.listAcceptedInboundSharedPackages(...args),
}))

const { loadSearchRowsAndRegistry } = await import('./search-loaders.ts')

function packageRecord(input: { id: string; userId: string; name: string }) {
	return {
		id: input.id,
		userId: input.userId,
		name: input.name,
		kodyId: input.name.split('/').pop() ?? input.name,
		description: '',
		tags: [],
		searchText: null,
		hasApp: false,
		isPrivate: false,
		hidden: false,
		sourceId: `source-${input.id}`,
	}
}

test('search rows load inbound shared packages without waiting on the caller package list', async () => {
	let releaseOwnList!: () => void
	const ownListGate = new Promise<void>((resolve) => {
		releaseOwnList = resolve
	})
	const own = packageRecord({
		id: 'pkg-own',
		userId: 'user-1',
		name: '@me/own',
	})
	const shared = packageRecord({
		id: 'pkg-shared',
		userId: 'user-2',
		name: '@friend/shared',
	})
	mockModule.listSavedPackagesWithCommunityProvenanceByUserId.mockImplementation(
		async () => {
			await ownListGate
			return [own]
		},
	)
	mockModule.listAcceptedInboundSharedPackages.mockResolvedValue([
		{ id: 'pkg-shared', userId: 'user-2' },
		{ id: 'pkg-own', userId: 'user-1' },
	])
	mockModule.getSavedPackageWithCommunityProvenanceById.mockImplementation(
		async (_db: unknown, { packageId }: { packageId: string }) =>
			packageId === 'pkg-shared' ? shared : own,
	)

	const loading = loadSearchRowsAndRegistry({
		env: { APP_DB: {} } as unknown as Env,
		callerContext: { baseUrl: 'https://example.com' } as never,
		userId: 'user-1',
	})
	await vi.waitFor(() => {
		expect(
			mockModule.getSavedPackageWithCommunityProvenanceById,
		).toHaveBeenCalledTimes(2)
	})
	releaseOwnList()
	const rows = await loading

	expect(
		rows.packageRows.map((row) => ({
			id: row.record.id,
			shareGranted: row.shareGranted === true,
		})),
	).toEqual([
		{ id: 'pkg-own', shareGranted: false },
		{ id: 'pkg-shared', shareGranted: true },
	])
})
