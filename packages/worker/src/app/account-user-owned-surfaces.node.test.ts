import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	accountUserOwnedDurableObjectSurfaces,
	accountUserOwnedKvKeySchemes,
	accountUserOwnedR2Surfaces,
	accountUserOwnedVectorizeSurfaces,
	getAccountDeletionDurableObjectResultKeys,
	getAccountExportExcludedDurableObjects,
	getAccountUserOwnedSurfaceCoverage,
} from './account-user-owned-surfaces.ts'

const accountDeletionSource = readFileSync(
	fileURLToPath(new URL('./account-deletion.ts', import.meta.url)),
	'utf8',
)
const accountExportSource = readFileSync(
	fileURLToPath(new URL('./account-export.ts', import.meta.url)),
	'utf8',
)
const manifestCacheSource = readFileSync(
	fileURLToPath(
		new URL('../package-retrievers/manifest-cache.ts', import.meta.url),
	),
	'utf8',
)

test('account deletion and export consume the out-of-band surface registry', () => {
	const coverage = getAccountUserOwnedSurfaceCoverage()
	const deletionResultKeys = [
		...getAccountDeletionDurableObjectResultKeys(),
	].sort()
	const excludedNames = getAccountExportExcludedDurableObjects()
		.map((entry) => entry.name)
		.sort()

	expect(coverage.durableObjectIds.size).toBeGreaterThan(0)
	expect(coverage.vectorizeIds.size).toBeGreaterThan(0)
	expect(coverage.kvSchemeIds.size).toBeGreaterThan(0)
	expect(coverage.r2SurfaceIds.size).toBeGreaterThan(0)
	expect(coverage.artifactSurfaceIds.size).toBeGreaterThan(0)
	expect(deletionResultKeys).toEqual(
		accountUserOwnedDurableObjectSurfaces
			.map((surface) => surface.deletionResultKey)
			.filter((key): key is string => key != null)
			.sort(),
	)
	expect(excludedNames.length).toBeGreaterThan(0)
	expect(
		accountUserOwnedDurableObjectSurfaces.filter(
			(surface) => surface.export === 'exclude',
		).length,
	).toBeGreaterThanOrEqual(excludedNames.length)

	expect(
		accountUserOwnedVectorizeSurfaces.every(
			(surface) => surface.export === 'rebuild_from_d1',
		),
	).toBe(true)
	expect(
		accountUserOwnedR2Surfaces.every(
			(surface) => surface.export === 'chunked_bytes',
		),
	).toBe(true)
	expect(coverage.r2SurfaceIds.has('email_raw_mime')).toBe(true)
	expect(coverage.r2SurfaceIds.has('user_avatar')).toBe(true)
	expect(
		accountUserOwnedKvKeySchemes.some((scheme) =>
			scheme.prefixTemplate?.includes('source-snapshot:v1:'),
		),
	).toBe(true)

	expect(accountDeletionSource).toContain(
		"from '#app/account-user-owned-surfaces.ts'",
	)
	expect(accountDeletionSource).toContain(
		'getAccountDeletionDurableObjectResultKeys',
	)
	expect(accountDeletionSource).toContain('accountUserOwnedVectorizeSurfaces')
	expect(accountDeletionSource).toContain('deleteAccountCommunityAssetPrefixes')
	expect(accountExportSource).toContain(
		'getAccountExportExcludedDurableObjects',
	)
	expect(accountExportSource).toContain('readAccountR2ExportPage')
	expect(accountExportSource).not.toContain('collectAccountR2Inventory')
	expect(manifestCacheSource).toContain('legacyRetrieverScopeIndexPrefix')
	expect(manifestCacheSource).toContain(
		'deleteLegacyPackageRetrieverScopeIndexes',
	)

	for (const prefix of [
		'source-snapshot:v1:',
		'source-manifest-snapshot:v1:',
	]) {
		expect(
			accountDeletionSource.includes(prefix),
			`account-deletion.ts must still enumerate prefix ${prefix}`,
		).toBe(true)
	}

	for (const surface of accountUserOwnedDurableObjectSurfaces) {
		if (surface.deletionResultKey == null) continue
		expect(
			accountDeletionSource.includes(surface.deletionResultKey),
			`account-deletion.ts missing clearedDurableObjects key ${surface.deletionResultKey}`,
		).toBe(true)
	}
})
