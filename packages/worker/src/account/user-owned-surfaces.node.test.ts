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
} from './user-owned-surfaces.ts'

const accountDeletionSource = readFileSync(
	fileURLToPath(new URL('../app/account-deletion.ts', import.meta.url)),
	'utf8',
)
const accountExportSource = readFileSync(
	fileURLToPath(new URL('./export.ts', import.meta.url)),
	'utf8',
)

function surface<T extends { id: string }>(
	surfaces: ReadonlyArray<T>,
	id: string,
) {
	return surfaces.find((entry) => entry.id === id)
}

test('account deletion and export consume the out-of-band surface registry', () => {
	const coverage = getAccountUserOwnedSurfaceCoverage()
	const excludedNames = getAccountExportExcludedDurableObjects().map(
		(entry) => entry.name,
	)
	const deletionResultKeys = accountUserOwnedDurableObjectSurfaces
		.map((entry) => entry.deletionResultKey)
		.filter((key): key is string => key != null)

	expect(coverage.vectorizeIds.size).toBeGreaterThan(0)
	expect(coverage.artifactSurfaceIds.size).toBeGreaterThan(0)
	expect([...getAccountDeletionDurableObjectResultKeys()].sort()).toEqual(
		[...deletionResultKeys].sort(),
	)
	expect(excludedNames.length).toBeGreaterThan(0)
	expect(
		accountUserOwnedDurableObjectSurfaces.filter(
			(entry) => entry.export === 'exclude',
		).length,
	).toBeGreaterThanOrEqual(excludedNames.length)
	expect(
		accountUserOwnedVectorizeSurfaces.every(
			(entry) => entry.export === 'rebuild_from_d1',
		),
	).toBe(true)
	expect(
		accountUserOwnedR2Surfaces.every(
			(entry) => entry.export === 'chunked_bytes',
		),
	).toBe(true)
	expect([...coverage.r2SurfaceIds]).toEqual(
		expect.arrayContaining(['email_raw_mime', 'user_avatar', 'identity_icon']),
	)
	expect([...coverage.kvSchemeIds]).toContain('identity_icon_derived_cache')
	expect([...coverage.durableObjectIds]).toEqual(
		expect.arrayContaining(['user_meter', 'mailbox', 'repo_session_index']),
	)

	const durableObjects = accountUserOwnedDurableObjectSurfaces
	expect(surface(durableObjects, 'user_meter')).toMatchObject({
		binding: 'USER_METER',
		deletionResultKey: 'userMeters',
		export: 'include',
	})
	expect(surface(durableObjects, 'mailbox')).toMatchObject({
		binding: 'MAILBOX',
		deletionResultKey: 'mailboxes',
		export: 'include',
		notes: expect.stringMatching(
			/authoritative email metadata.*lists Mailbox blob references.*D1 retains only thin provider/s,
		),
	})
	expect(surface(durableObjects, 'repo_session_index')).toMatchObject({
		binding: 'REPO_SESSION_INDEX',
		deletionResultKey: 'repoSessionIndexes',
		export: 'include',
	})
	expect(surface(durableObjects, 'run_log')?.notes).toMatch(
		/There are no D1 tables workflow_runs/,
	)
	expect(surface(accountUserOwnedR2Surfaces, 'email_raw_mime')).toMatchObject({
		sourceTable: 'Mailbox.email_messages',
		sourceColumn: 'id',
	})
	expect(
		surface(accountUserOwnedR2Surfaces, 'email_attachment_storage_key'),
	).toMatchObject({
		sourceTable: 'Mailbox.email_attachments',
		sourceColumn: 'storage_key',
	})
	const kvPrefixes = accountUserOwnedKvKeySchemes.map(
		(scheme) => scheme.prefixTemplate ?? '',
	)
	expect(
		kvPrefixes.some((prefix) => prefix.includes('source-snapshot:v1:')),
	).toBe(true)
	expect(
		kvPrefixes.filter((prefix) => prefix.startsWith('platform-settings:')),
	).toEqual([])

	for (const snippet of [
		"'user_meter'",
		'userMeterRpc',
		"'mailbox'",
		'exportInternalUserMailbox',
		"'repo_session_index'",
		'repoSessionIndexRpc',
		'getAccountExportExcludedDurableObjects',
		'readAccountR2ExportPage',
	]) {
		expect(accountExportSource).toContain(snippet)
	}
	expect(accountExportSource).not.toContain('collectAccountR2Inventory')
	for (const snippet of [
		'userMeterRpc',
		'mailboxRpc',
		'repoSessionIndexRpc',
		"from '#worker/account/user-owned-surfaces.ts'",
		'getAccountDeletionDurableObjectResultKeys',
		'accountUserOwnedVectorizeSurfaces',
		'deleteAccountCommunityAssetPrefixes',
		'source-snapshot:v1:',
		'source-manifest-snapshot:v1:',
		...deletionResultKeys,
	]) {
		expect(accountDeletionSource).toContain(snippet)
	}
})
