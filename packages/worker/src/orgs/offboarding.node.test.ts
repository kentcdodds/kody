import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'

const updateJob = vi.fn(async () => true)
const deleteJob = vi.fn(async () => true)
const listJobsForUser = vi.fn(async () => [
	{
		id: 'job-1',
		name: 'Nightly',
		user_id: 'org-1',
		created_by_user_id: 'member-1',
		deleted_at: null,
	},
])
const getJobById = vi.fn(async () => ({
	id: 'job-1',
	user_id: 'org-1',
	created_by_user_id: 'member-1',
	callerContextJson: '{}',
	record: {
		id: 'job-1',
		userId: 'org-1',
		name: 'Nightly',
		enabled: true,
		updatedAt: '2026-10-01T00:00:00.000Z',
	},
}))

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		listJobsForUser,
		getJobById,
		updateJob,
		deleteJob,
	}),
}))
vi.mock('#worker/jobs/manager-client.ts', () => ({
	syncJobManagerAlarm: vi.fn(async () => ({
		ok: true,
		userId: 'mock',
		nextRunAt: null,
	})),
}))

const { offboardOrgMember, previewMemberOffboarding, revokeOAuthGrantsForOrg } =
	await import('./offboarding.ts')

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	const ts = '2026-01-01T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, plan, entitlement_ladder, created_at, updated_at)
			 VALUES ('org-1', 'acme', 'Acme', 'free', 'public', ?, ?)`,
		)
		.bind(ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES ('org-1', 'owner-1', 'owner', ?), ('org-1', 'member-1', 'member', ?)`,
		)
		.bind(ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO user_oauth_apps (
				user_id, slug, provider, client_id, token_url, flow,
				extra_authorize_params_json, created_at, updated_at
			) VALUES (
				'org-1', 'github', 'github', 'client', 'https://example.com/token', 'confidential',
				'{}', ?, ?
			)`,
		)
		.bind(ts, ts)
		.run()
	await db
		.prepare(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, description, scopes_json, required_hosts_json,
				access_token_encrypted, refresh_token_encrypted, connected_by_user_id,
				connected_at, created_at, updated_at
			) VALUES (
				'org-1', 'github', 'github', '', '[]', '[]',
				'cipher', 'refresh', 'member-1',
				?, ?, ?
			)`,
		)
		.bind(ts, ts, ts)
		.run()
	return db
}

test('preview lists member jobs and own-login integrations', async () => {
	const db = await createDb()
	const preview = await previewMemberOffboarding({
		appDb: db,
		env: { APP_DB: db } as Env,
		orgId: 'org-1',
		memberUserId: 'member-1',
	})
	expect(preview.jobs).toEqual([{ id: 'job-1', name: 'Nightly' }])
	expect(preview.ownLoginIntegrations).toEqual(['github'])
})

test('offboarding soft-deletes membership, disconnects integrations, applies job cancel', async () => {
	const db = await createDb()
	const result = await offboardOrgMember({
		appDb: db,
		env: { APP_DB: db } as Env,
		orgId: 'org-1',
		memberUserId: 'member-1',
		memberLeftVoluntarily: false,
		jobChoices: [{ jobId: 'job-1', disposition: 'cancel' }],
		now: new Date('2026-10-01T12:00:00.000Z'),
	})
	expect(result.membershipSoftDeleted).toBe(true)
	expect(result.disconnectedIntegrations).toEqual(['github'])
	expect(result.jobDispositions).toEqual([
		{ jobId: 'job-1', disposition: 'cancel' },
	])
	expect(updateJob).toHaveBeenCalled()
	const tokens = await db
		.prepare(
			`SELECT access_token_encrypted, refresh_token_encrypted, connected_at
			 FROM user_integrations WHERE user_id = 'org-1' AND name = 'github'`,
		)
		.first<{
			access_token_encrypted: string | null
			refresh_token_encrypted: string | null
			connected_at: string | null
		}>()
	expect(tokens?.access_token_encrypted).toBeNull()
	expect(tokens?.refresh_token_encrypted).toBeNull()
	expect(tokens?.connected_at).toBeNull()
	const membership = await db
		.prepare(
			`SELECT deleted_at FROM org_memberships WHERE org_id = 'org-1' AND user_id = 'member-1'`,
		)
		.first<{ deleted_at: string | null }>()
	expect(membership?.deleted_at).toBeTruthy()
})

test('cannot remove the last live owner', async () => {
	const db = await createDb()
	await expect(
		offboardOrgMember({
			appDb: db,
			env: { APP_DB: db } as Env,
			orgId: 'org-1',
			memberUserId: 'owner-1',
			memberLeftVoluntarily: false,
		}),
	).rejects.toThrow('cannot_remove_last_owner')
})

test('revokeOAuthGrantsForOrg matches metadata.orgId with userId fallback', async () => {
	const revokeGrant = vi.fn(async () => undefined)
	const helpers = {
		listUserGrants: async () => ({
			items: [
				{ id: 'g1', clientId: 'c1', scope: [], metadata: { orgId: 'org-1' } },
				{ id: 'g2', clientId: 'c2', scope: [], metadata: { orgId: 'other' } },
				{ id: 'g3', clientId: 'c3', scope: [] },
			],
		}),
		revokeGrant,
	}
	const revoked = await revokeOAuthGrantsForOrg({
		helpers,
		memberUserId: 'member-1',
		orgId: 'org-1',
	})
	expect(revoked).toBe(1)
	expect(revokeGrant).toHaveBeenCalledWith('g1', 'member-1')

	revokeGrant.mockClear()
	const revokedPersonal = await revokeOAuthGrantsForOrg({
		helpers,
		memberUserId: 'member-1',
		orgId: 'member-1',
	})
	expect(revokedPersonal).toBe(1)
	expect(revokeGrant).toHaveBeenCalledWith('g3', 'member-1')
})
