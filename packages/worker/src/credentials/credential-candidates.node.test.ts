import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import {
	listUsableCredentials,
	resolveNeedCandidates,
} from './credential-candidates.ts'
import { grantPersonalCredentialToOrg } from './personal-credentials.ts'

const now = '2026-10-12T00:00:00.000Z'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const people = Object.fromEntries(
		(['ann', 'bea'] as const).map((username) => {
			const stableUserId = testStableUserIdFromEmail(`${username}@example.com`)
			return [
				username,
				{ stableUserId, personId: personIdFromStored(stableUserId) },
			]
		}),
	) as Record<
		'ann' | 'bea',
		{ stableUserId: string; personId: ReturnType<typeof personIdFromStored> }
	>
	for (const [username, person] of Object.entries(people)) {
		await provisionPersonalOrg(db, {
			stableUserId: person.stableUserId,
			username,
			createdAt: now,
		})
	}
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: people.bea.personId,
			audit: createTestOrgAuditWriter(),
			slug: 'acme-needs',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'acme-needs'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(acmeId, people.ann.stableUserId, now)
		.run()
	const storeSecret = async (input: {
		ownerId: OwnerId
		name: string
		provider?: string | null
		kind?: string
		hosts?: Array<string>
		expiresAt?: string
	}) => {
		await saveSecret({
			env,
			userId: input.ownerId,
			scope: 'user',
			name: input.name,
			value: 'value-never-read',
			...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
		})
		const row = await db
			.prepare(
				`UPDATE secret_entries SET kind = ?, provider = ?, allowed_hosts = ?
				WHERE name = ? AND bucket_id IN (
					SELECT id FROM secret_buckets WHERE user_id = ? AND scope = 'user'
				)
				RETURNING id`,
			)
			.bind(
				input.kind ?? 'secret',
				input.provider ?? null,
				JSON.stringify(input.hosts ?? []),
				input.name,
				input.ownerId,
			)
			.first<{ id: string }>()
		return row!.id
	}
	const requestAs = (
		person: keyof typeof people,
		role: OrgRole | null,
		scopes?: Array<OrgPermission>,
	) =>
		deriveRequestContext({
			user: { userId: people[person].personId, username: person },
			source: { kind: 'mcp-oauth' },
			orgBinding: { org: { id: acmeId, slug: 'acme-needs' }, role },
			scopes: scopes ?? null,
		})
	const usableAs = (
		person: keyof typeof people,
		role: OrgRole | null,
		scopes?: Array<OrgPermission>,
	) => listUsableCredentials({ env, request: requestAs(person, role, scopes) })
	const grantUse = (credentialId: string, person: keyof typeof people) =>
		upsertGrant({
			db,
			orgId: acmeId,
			resourceType: 'credential',
			resourceId: credentialId,
			family: 'secret',
			subject: { type: 'user', id: people[person].stableUserId },
			preset: 'use',
			permissions: null,
			createdByUserId: people.bea.stableUserId,
			audit: createTestOrgAuditWriter(),
		})
	return { db, env, people, acmeId, storeSecret, usableAs, grantUse }
}

test('needs resolve by kind and provider; a credential with no provider is only an option', async () => {
	const t = await setup()
	await t.storeSecret({
		ownerId: t.acmeId,
		name: 'gh-pat',
		provider: 'github',
		hosts: ['api.github.com'],
	})
	await t.storeSecret({ ownerId: t.acmeId, name: 'loose-key' })
	await t.storeSecret({
		ownerId: t.acmeId,
		name: 'deploy-hook',
		kind: 'url',
		provider: 'slack',
		hosts: ['hooks.slack.com'],
	})
	await t.storeSecret({
		ownerId: t.acmeId,
		name: 'old-key',
		provider: 'linear',
		expiresAt: '2020-01-01T00:00:00.000Z',
	})
	await t.db
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url, provider)
			VALUES ('mcp-1', ?, 'linear-mcp', 'https://mcp.linear.app/sse', 'linear')`,
		)
		.bind(t.acmeId)
		.run()
	const usable = await t.usableAs('bea', 'owner')
	expect(
		usable.map(({ name, kind, provider, hosts, scope }) => ({
			name,
			kind,
			provider,
			hosts,
			scope,
		})),
	).toEqual([
		{
			name: 'deploy-hook',
			kind: 'url',
			provider: 'slack',
			hosts: ['hooks.slack.com'],
			scope: 'org',
		},
		{
			name: 'gh-pat',
			kind: 'secret',
			provider: 'github',
			hosts: ['api.github.com'],
			scope: 'org',
		},
		{
			name: 'linear-mcp',
			kind: 'mcp',
			provider: 'linear',
			hosts: ['mcp.linear.app'],
			scope: 'org',
		},
		{
			name: 'loose-key',
			kind: 'secret',
			provider: null,
			hosts: [],
			scope: 'org',
		},
	])
	const github = resolveNeedCandidates(
		{ kind: 'secret', provider: 'github' },
		usable,
	)
	expect(github.status).toBe('ready')
	expect(github.autoPick?.name).toBe('gh-pat')
	expect(github.options.map((option) => option.name)).toEqual([
		'gh-pat',
		'loose-key',
	])
	expect(
		resolveNeedCandidates({ kind: 'oauth', provider: 'github' }, usable),
	).toMatchObject({ status: 'unbound', autoPick: null, options: [] })
	const resend = resolveNeedCandidates(
		{ kind: 'secret', provider: 'resend' },
		usable,
	)
	expect(resend.status).toBe('unbound')
	expect(resend.possibleMatches.map((option) => option.name)).toEqual([
		'loose-key',
	])
	expect(
		resolveNeedCandidates({ kind: 'mcp', provider: 'linear' }, usable).autoPick
			?.name,
	).toBe('linear-mcp')

	await t.storeSecret({
		ownerId: t.acmeId,
		name: 'gh-pat-2',
		provider: 'github',
	})
	expect(
		resolveNeedCandidates(
			{ kind: 'secret', provider: 'github' },
			await t.usableAs('bea', 'owner'),
		),
	).toMatchObject({ status: 'ambiguous', autoPick: null })
})

test('omitted kind matches any fetch-capable credential for the provider', async () => {
	const t = await setup()
	await t.storeSecret({
		ownerId: t.acmeId,
		name: 'gh-pat',
		provider: 'github',
	})
	await t.db
		.prepare(
			`INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, api_base_url, flow)
			VALUES (?, 'gh-app', 'github', 'client-id', 'https://github.com/login/oauth/access_token',
				'https://api.github.com', 'confidential')`,
		)
		.bind(t.acmeId)
		.run()
	await t.db
		.prepare(
			`INSERT INTO user_integrations (user_id, name, app_slug, provider, required_hosts_json, connected_at)
			VALUES (?, 'gh-oauth', 'gh-app', 'github', '[]', ?)`,
		)
		.bind(t.acmeId, now)
		.run()
	await t.db
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url, provider)
			VALUES ('mcp-omit', ?, 'linear-mcp', 'https://mcp.linear.app/sse', 'linear')`,
		)
		.bind(t.acmeId)
		.run()
	await t.storeSecret({
		ownerId: t.acmeId,
		name: 'loose-key',
		provider: null,
	})
	const usable = await t.usableAs('bea', 'owner')
	const omitted = resolveNeedCandidates({ provider: 'github' }, usable)
	expect(omitted.status).toBe('ambiguous')
	expect(
		omitted.candidates.map((credential) => credential.name).sort(),
	).toEqual(['gh-oauth', 'gh-pat'])
	expect(omitted.possibleMatches.map((credential) => credential.name)).toEqual([
		'loose-key',
	])
	expect(
		resolveNeedCandidates({ provider: 'linear' }, usable).candidates,
	).toEqual([])
	expect(
		resolveNeedCandidates({ kind: 'secret', provider: 'github' }, usable)
			.autoPick?.name,
	).toBe('gh-pat')
})

test('a member sees only org credentials they can Use, plus their own granted personal ones', async () => {
	const t = await setup()
	const orgKey = await t.storeSecret({
		ownerId: t.acmeId,
		name: 'gh-pat',
		provider: 'github',
	})
	expect(await t.usableAs('ann', 'member')).toEqual([])
	await t.grantUse(orgKey, 'ann')
	expect(
		(await t.usableAs('ann', 'member')).map((credential) => credential.name),
	).toEqual(['gh-pat'])

	const personal = await t.storeSecret({
		ownerId: personalOrgId(t.people.ann.personId),
		name: 'ann-gh',
		provider: 'github',
		hosts: ['api.github.com'],
	})
	await grantPersonalCredentialToOrg({
		db: t.db,
		ownerPersonId: t.people.ann.personId,
		credentialId: personal,
		orgId: t.acmeId,
	})
	const asAnn = await t.usableAs('ann', 'member')
	expect(asAnn.map(({ name, scope }) => ({ name, scope }))).toEqual([
		{ name: 'ann-gh', scope: 'personal' },
		{ name: 'gh-pat', scope: 'org' },
	])
	expect(
		resolveNeedCandidates({ kind: 'secret', provider: 'github' }, asAnn).status,
	).toBe('ambiguous')
	// A token without Use lists neither org nor personal credentials.
	expect(await t.usableAs('ann', 'member', ['package:read'])).toEqual([])
	expect(
		(await t.usableAs('ann', 'member', ['package:read', 'secret:use'])).map(
			(credential) => credential.name,
		),
	).toEqual(['ann-gh', 'gh-pat'])
	// The org owner never sees a member's personal credential.
	expect(
		(await t.usableAs('bea', 'owner')).map((credential) => credential.name),
	).toEqual(['gh-pat'])
})

test('an OAuth connection lists the hosts the runtime allows, including its API base URL', async () => {
	const t = await setup()
	await t.db
		.prepare(
			`INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, api_base_url, flow)
			VALUES (?, 'gh-app', 'github', 'client-id', 'https://github.com/login/oauth/access_token',
				'https://api.github.com/v3', 'confidential')`,
		)
		.bind(t.acmeId)
		.run()
	await t.db
		.prepare(
			`INSERT INTO user_integrations (user_id, name, app_slug, provider, required_hosts_json, connected_at)
			VALUES (?, 'github', 'gh-app', 'github', '["uploads.github.com"]', ?)`,
		)
		.bind(t.acmeId, now)
		.run()
	// A connection whose app was deleted still lists, with its stored hosts.
	await t.db
		.prepare(
			`INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, api_base_url, flow, deleted_at)
			VALUES (?, 'deleted-app', 'linear', 'client-id', 'https://linear.app/token',
				'https://old.linear.app', 'confidential', ?)`,
		)
		.bind(t.acmeId, now)
		.run()
	await t.db
		.prepare(
			`INSERT INTO user_integrations (user_id, name, app_slug, provider, required_hosts_json, connected_at)
			VALUES (?, 'orphan', 'deleted-app', 'linear', '["api.linear.app"]', ?)`,
		)
		.bind(t.acmeId, now)
		.run()
	expect(
		(await t.usableAs('bea', 'owner')).map(({ name, kind, hosts }) => ({
			name,
			kind,
			hosts,
		})),
	).toEqual([
		{
			name: 'github',
			kind: 'oauth',
			hosts: ['uploads.github.com', 'api.github.com'],
		},
		{ name: 'orphan', kind: 'oauth', hosts: ['api.linear.app'] },
	])
})
