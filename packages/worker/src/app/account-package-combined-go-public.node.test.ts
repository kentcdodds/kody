import { expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	mappingFixtureBaseUrl,
	setupPackageCredentialMappingFixture,
} from '#worker/test-support/package-credential-mapping-fixture.ts'

const mocks = vi.hoisted(() => ({
	loadPackageManifestBySourceId: vi.fn(),
	reloadAccountPackagesAfterWrite: vi.fn(),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

vi.mock('#app/account-packages-data.ts', () => ({
	reloadAccountPackagesAfterWrite: mocks.reloadAccountPackagesAfterWrite,
}))

const {
	handleAccountPackageInternetVisibleAction,
	loadAccountPackageApproveCapabilitiesData,
} = await import('./account-package-capability-approval.ts')

async function setup() {
	const t = await setupPackageCredentialMappingFixture({
		loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
	})
	await t.db
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit,
				manifest_path, source_root, created_at, updated_at
			) VALUES (?, ?, 'package', ?, ?, 'commit-1', 'package.json', '/', ?, ?)`,
		)
		.bind(
			t.savedPackage.sourceId,
			t.acmeId,
			t.savedPackage.id,
			`repo-${t.savedPackage.id}`,
			'2026-10-13T00:00:00.000Z',
			'2026-10-13T00:00:00.000Z',
		)
		.run()
	mocks.reloadAccountPackagesAfterWrite.mockResolvedValue({ ok: true })
	const user = {
		userId: 0,
		username: 'bea',
		email: 'bea@example.com',
		mcpUser: { userId: t.people.bea.personId, username: 'bea' },
		request: t.requestAs('bea', 'owner'),
	} as unknown as AuthenticatedAppUser
	const post = (body: Record<string, unknown>) =>
		handleAccountPackageInternetVisibleAction({
			env: t.env,
			request: new Request(`${mappingFixtureBaseUrl}/account/packages.json`, {
				method: 'POST',
			}),
			user,
			body: { packageId: t.savedPackage.id, ...body },
		})
	const loadPage = async () => {
		const data = await loadAccountPackageApproveCapabilitiesData({
			env: t.env,
			request: new Request(
				`${mappingFixtureBaseUrl}/@acme-clients/digest/approve-capabilities`,
			),
			user,
			packageId: t.savedPackage.id,
		})
		if (!data.ok) throw new Error(data.error)
		return data
	}
	const packageAudits = async () => {
		const rows = await t.env.AUDIT_DB.prepare(
			`SELECT action, result, actor_user_id, actor_username, credential_kind,
				resource_type, resource_id, details_json
			FROM org_audit_events
			WHERE org_id = ? AND resource_type = 'package' ORDER BY rowid`,
		)
			.bind(t.acmeId)
			.all<{
				action: string
				result: string
				actor_user_id: string | null
				actor_username: string | null
				credential_kind: string | null
				resource_type: string | null
				resource_id: string | null
				details_json: string | null
			}>()
		return (rows.results ?? []).map((row) => ({
			action: row.action,
			result: row.result,
			actorUserId: row.actor_user_id,
			actorUsername: row.actor_username,
			credentialKind: row.credential_kind,
			resourceId: row.resource_id,
			details: row.details_json ? JSON.parse(row.details_json) : null,
		}))
	}
	return { ...t, post, loadPage, packageAudits }
}

test('asking to go public, then one Approve, records both decisions and serves the package', async () => {
	const t = await setup()

	const asked = await t.post({
		action: 'set-internet-visible',
		internetVisible: true,
		confirmName: 'digest',
	})
	expect(asked?.status).toBe(400)
	await expect(asked?.json()).resolves.toMatchObject({
		approvalUrl: `${mappingFixtureBaseUrl}/@acme-clients/digest/approve-capabilities`,
	})

	const page = await t.loadPage()
	expect(page.fingerprintMatchesApproval).toBe(false)
	expect(page.goPublicRequestId).toEqual(expect.any(String))
	expect(page.pendingApprovals.map((approval) => approval.id)).toEqual([
		page.goPublicRequestId,
	])

	const approved = await t.post({
		action: 'approve-capabilities-and-go-public',
		fingerprint: page.fingerprint,
		requestId: page.goPublicRequestId,
	})
	expect(approved?.status).toBe(200)

	const live = await getSavedPackageById(t.db, {
		userId: t.acmeId,
		packageId: t.savedPackage.id,
	})
	expect(live?.isInternetVisible).toBe(true)
	const pin = await t.db
		.prepare(
			`SELECT fingerprint, published_commit, approved_by_user_id
			FROM package_capability_approvals WHERE package_id = ?`,
		)
		.bind(t.savedPackage.id)
		.all<Record<string, string>>()
	expect(pin.results).toEqual([
		{
			fingerprint: page.fingerprint,
			published_commit: 'commit-1',
			approved_by_user_id: t.people.bea.stableUserId,
		},
	])
	const request = await t.db
		.prepare(
			`SELECT status, resolved_by_user_id FROM package_approval_requests
			WHERE id = ?`,
		)
		.bind(page.goPublicRequestId)
		.first<Record<string, string>>()
	expect(request).toEqual({
		status: 'approved',
		resolved_by_user_id: t.people.bea.stableUserId,
	})

	const shared = {
		result: 'success',
		actorUserId: t.people.bea.stableUserId,
		actorUsername: 'bea',
		credentialKind: 'session',
		resourceId: t.savedPackage.id,
	}
	expect(await t.packageAudits()).toEqual([
		{
			...shared,
			action: 'package.capabilities.approve',
			details: expect.objectContaining({
				packageId: t.savedPackage.id,
				kodyId: 'digest',
				fingerprint: page.fingerprint,
				publishedCommit: 'commit-1',
			}),
		},
		{
			...shared,
			action: 'package.went_public.approve',
			details: expect.objectContaining({
				packageId: t.savedPackage.id,
				requestId: page.goPublicRequestId,
			}),
		},
	])

	const after = await t.loadPage()
	expect(after.goPublicRequestId).toBeNull()
	expect(after.pendingApprovals).toEqual([])
})

test('approving the capability set alone does not offer the combined Approve', async () => {
	const t = await setup()
	const page = await t.loadPage()
	expect(page.goPublicRequestId).toBeNull()

	const approved = await t.post({
		action: 'approve-capabilities',
		fingerprint: page.fingerprint,
	})
	expect(approved?.status).toBe(200)
	const after = await t.loadPage()
	expect(after.fingerprintMatchesApproval).toBe(true)
	expect(after.goPublicRequestId).toBeNull()
	expect(after.pendingApprovals.map((approval) => approval.reason)).toEqual([
		'went_public',
	])
	expect(
		(
			await getSavedPackageById(t.db, {
				userId: t.acmeId,
				packageId: t.savedPackage.id,
			})
		)?.isInternetVisible,
	).toBe(false)
})
