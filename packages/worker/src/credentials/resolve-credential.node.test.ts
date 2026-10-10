/**
 * Real-boundary coverage for the credential door: migrated APP_DB and
 * AUDIT_DB, real secrets, real org memberships and grants.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { SecretHostNotApprovedError } from '#mcp/secrets/errors.ts'
import { SecretProviderGrantDeniedError } from '#mcp/secrets/secret-providers/errors.ts'
import { saveSecret, setSecretAllowedHosts } from '#mcp/secrets/service.ts'
import {
	attestedPackageStamp,
	claimedPackageStamp,
	type PackageStamp,
} from './package-stamp.ts'
import { resolveCredential } from './resolve-credential.ts'

const scheduledAudits = vi.hoisted(() => [] as Array<Promise<unknown>>)

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: (promise: Promise<unknown>) => {
		scheduledAudits.push(promise)
	},
}))

vi.mock('#mcp/secrets/secret-providers/declared-provider.ts', () => ({
	readDeclaredSecretProviderId: async () => '1password',
}))

const now = '2026-10-10T00:00:00.000Z'
const secretValue = 'org-secret-value-never-audited'

type AuditRow = {
	org_id: string
	actor_user_id: string | null
	actor_username: string | null
	credential_kind: string | null
	credential_id: string | null
	action: string
	resource_type: string | null
	resource_id: string | null
	result: string
	details_json: string | null
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditTestDb()
	const ownerStableId = testStableUserIdFromEmail('owner@example.com')
	const orgId = ownerIdFromStored(ownerStableId)
	const memberId = testStableUserIdFromEmail('member@example.com')
	const collaboratorId = testStableUserIdFromEmail('collab@example.com')
	for (const [stableUserId, username] of [
		[ownerStableId, 'owner'],
		[memberId, 'member'],
		[collaboratorId, 'collab'],
	] as const) {
		await provisionPersonalOrg(db, { stableUserId, username, createdAt: now })
	}
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(orgId, memberId, now)
		.run()
	const packageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: orgId,
			name: '@owner/notes',
			kody_id: 'notes',
			description: 'notes',
			tags_json: '[]',
			search_text: null,
			source_id: `source-${packageId}`,
			has_app: 0,
			has_skills: 0,
			hidden: 0,
			is_private: 1,
			created_at: now,
			updated_at: now,
		},
		null,
		{ stamp: false },
	)
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	await saveSecret({
		env,
		userId: orgId,
		scope: 'user',
		name: 'orgToken',
		value: secretValue,
	})
	await upsertGrant({
		db,
		orgId,
		resourceType: 'package',
		resourceId: packageId,
		subject: { type: 'user', id: collaboratorId },
		preset: 'use',
		permissions: null,
		createdByUserId: ownerStableId,
		audit: createTestOrgAuditWriter(),
	})

	const personRequest = (
		stableUserId: string,
		username: string,
		role: OrgRole | null,
	) =>
		deriveRequestContext({
			user: { userId: personIdFromStored(stableUserId), username },
			source: { kind: 'mcp-oauth' },
			orgBinding: { org: { id: orgId, slug: 'owner' }, role },
		})
	const resolveSecretAs = (
		actor: ReturnType<typeof personRequest> | null,
		packageStamp: PackageStamp | null = null,
		name = 'orgToken',
	) =>
		resolveCredential({
			env,
			orgId,
			actor,
			packageStamp,
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name,
				storageContext: {
					sessionId: null,
					appId: null,
					packageId: packageStamp?.packageId ?? null,
				},
			},
		})
	const auditRows = async () => {
		await Promise.all(scheduledAudits.splice(0))
		const { results } = await auditDb
			.prepare(
				`SELECT * FROM org_audit_events
				 WHERE action = 'credential.resolve' ORDER BY rowid`,
			)
			.all<AuditRow>()
		return results
	}
	return {
		env,
		db,
		auditDb,
		orgId,
		ownerStableId,
		memberId,
		collaboratorId,
		packageId,
		personRequest,
		resolveSecretAs,
		auditRows,
	}
}

function details(row: AuditRow | undefined) {
	return JSON.parse(row?.details_json ?? 'null') as Record<string, unknown>
}

async function denial(promise: Promise<unknown>) {
	return promise.then(
		() => null,
		(error: unknown) => error,
	)
}

test('owner resolves an ad-hoc secret; the door schedules exactly one audit row without the value', async () => {
	const t = await setup()
	const owner = t.personRequest(t.ownerStableId, 'owner', 'owner')

	const resolved = await t.resolveSecretAs(owner)
	expect(resolved).toMatchObject({ found: true, value: secretValue })
	expect(scheduledAudits).toHaveLength(1)

	const rows = await t.auditRows()
	expect(rows).toHaveLength(1)
	expect(rows[0]).toMatchObject({
		org_id: t.orgId,
		actor_user_id: t.ownerStableId,
		actor_username: 'owner',
		credential_kind: 'mcp-oauth',
		action: 'credential.resolve',
		resource_type: 'secret',
		resource_id: 'orgToken',
		result: 'success',
	})
	expect(details(rows[0])).toEqual({
		use: 'secret',
		actorKind: 'person',
		ownerKind: 'org',
		packageStampKind: 'none',
		packageId: null,
	})
	expect(JSON.stringify(rows)).not.toContain(secretValue)

	// One row per resolution, including a missing credential.
	await t.resolveSecretAs(owner)
	await expect(
		t.resolveSecretAs(owner, null, 'missingToken'),
	).resolves.toMatchObject({ found: false })
	const more = await t.auditRows()
	expect(more.map((row) => [row.resource_id, row.result])).toEqual([
		['orgToken', 'success'],
		['orgToken', 'success'],
		['missingToken', 'failure'],
	])
	expect(details(more[2])).toMatchObject({ reason: 'not_found' })
})

test('ad-hoc use without secret:use is denied and audited as denied (#3169)', async () => {
	const t = await setup()
	for (const actor of [
		t.personRequest(t.memberId, 'member', 'member'),
		t.personRequest(t.collaboratorId, 'collab', null),
	]) {
		const error = await denial(t.resolveSecretAs(actor))
		expect(error).toBeInstanceOf(AuthorizationError)
		expect(error).toMatchObject({
			code: 'missing_permission',
			permission: 'secret:use',
		})
	}
	const rows = await t.auditRows()
	expect(rows.map((row) => [row.actor_user_id, row.result])).toEqual([
		[t.memberId, 'denied'],
		[t.collaboratorId, 'denied'],
	])
	expect(details(rows[0])).toMatchObject({
		reason: 'missing_permission',
		packageStampKind: 'none',
	})
})

test('a claimed package stamp never skips Use; the attested stamp for the same package does (#3210)', async () => {
	const t = await setup()
	const member = t.personRequest(t.memberId, 'member', 'member')

	const forged = await denial(
		t.resolveSecretAs(member, claimedPackageStamp(t.packageId)),
	)
	expect(forged).toBeInstanceOf(AuthorizationError)
	expect(forged).toMatchObject({ code: 'missing_permission' })

	await expect(
		t.resolveSecretAs(member, attestedPackageStamp(t.packageId)),
	).resolves.toMatchObject({ found: true })

	const rows = await t.auditRows()
	expect(rows.map((row) => row.result)).toEqual(['denied', 'success'])
	expect(details(rows[0])).toMatchObject({
		packageStampKind: 'claimed',
		packageId: t.packageId,
	})
	expect(details(rows[1])).toMatchObject({
		packageStampKind: 'attested',
		packageId: t.packageId,
	})
})

test('a removed member is denied at resolve time even with a stale request context', async () => {
	const t = await setup()
	const attested = attestedPackageStamp(t.packageId)
	await expect(
		t.resolveSecretAs(
			t.personRequest(t.memberId, 'member', 'member'),
			attested,
		),
	).resolves.toMatchObject({ found: true })

	// Only the membership row ends: the door re-reads access itself instead
	// of relying on the removal cascade or the role baked into the request.
	await t.db
		.prepare(
			`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ? AND user_id = ?`,
		)
		.bind(now, t.orgId, t.memberId)
		.run()
	const staleRequest = t.personRequest(t.memberId, 'member', 'member')
	for (const packageStamp of [null, attested]) {
		const error = await denial(t.resolveSecretAs(staleRequest, packageStamp))
		expect(error).toBeInstanceOf(AuthorizationError)
		expect(error).toMatchObject({ code: 'wrong_org' })
	}

	// A live grant left in place makes them an outside collaborator, who keeps
	// access to what the grant covers.
	await upsertGrant({
		db: t.db,
		orgId: t.orgId,
		resourceType: 'secret',
		resourceId: 'orgToken',
		subject: { type: 'user', id: t.memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: t.ownerStableId,
		audit: createTestOrgAuditWriter(),
	})
	await expect(
		t.resolveSecretAs(t.personRequest(t.memberId, 'member', null)),
	).resolves.toMatchObject({ found: true })

	const rows = await t.auditRows()
	expect(rows.map((row) => row.result)).toEqual([
		'success',
		'denied',
		'denied',
		'success',
	])
	expect(details(rows[1])).toMatchObject({ reason: 'wrong_org' })
})

test('automation and platform resolutions keep today’s rules and are audited', async () => {
	const t = await setup()
	const schedule = deriveRequestContext({
		user: { userId: personIdFromStored(t.ownerStableId), username: 'owner' },
		source: { kind: 'schedule', jobId: 'job-1' },
		orgBinding: { org: { id: t.orgId, slug: 'owner' }, role: 'owner' },
	})
	await expect(
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: schedule,
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name: 'orgToken',
				storageContext: { sessionId: null, appId: null, packageId: null },
			},
		}),
	).resolves.toMatchObject({ found: true })
	await expect(
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: null,
			packageStamp: attestedPackageStamp(t.packageId),
			baseUrl: 'https://example.com',
			credential: { use: 'webhook-secret', name: 'orgToken' },
		}),
	).resolves.toMatchObject({ found: true })

	const rows = await t.auditRows()
	expect(rows).toHaveLength(2)
	expect(rows[0]).toMatchObject({
		actor_user_id: null,
		credential_kind: 'schedule',
		credential_id: 'job-1',
		result: 'success',
	})
	expect(details(rows[0])).toMatchObject({
		use: 'secret',
		actorKind: 'automation',
		packageStampKind: 'none',
	})
	expect(rows[1]).toMatchObject({ actor_user_id: null, credential_kind: null })
	expect(details(rows[1])).toMatchObject({
		use: 'webhook-secret',
		actorKind: 'platform',
		packageStampKind: 'attested',
		packageId: t.packageId,
	})
})

test('a package app in a team org acts as the org’s own account; a deleted org is denied', async () => {
	const t = await setup()
	const created = await createOrganization(
		t.db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: personIdFromStored(t.ownerStableId),
			audit: createTestOrgAuditWriter(),
			slug: 'zeta-co',
			displayName: 'Zeta Co',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const teamOrg = await t.db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta-co'`)
		.first<{ id: string }>()
	const teamOrgId = ownerIdFromStored(teamOrg!.id)
	const teamPackageId = 'pkg-team-app'
	await t.db
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES (?, ?, 'team-app', 'team-app', '', 'source-pkg-team-app')`,
		)
		.bind(teamPackageId, teamOrgId)
		.run()
	await saveSecret({
		env: t.env,
		userId: teamOrgId,
		scope: 'user',
		name: 'teamToken',
		value: secretValue,
	})
	// What `PackageAppRuntimeBridge` builds: the org id as the request user.
	const packageAppRequest = () =>
		deriveRequestContext({
			user: { userId: personIdFromStored(teamOrg!.id) },
			source: { kind: 'package-app' },
			orgBinding: { org: { id: teamOrgId, slug: 'zeta-co' }, role: 'owner' },
		})
	const resolve = () =>
		resolveCredential({
			env: t.env,
			orgId: teamOrgId,
			actor: packageAppRequest(),
			packageStamp: attestedPackageStamp(teamPackageId),
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name: 'teamToken',
				storageContext: {
					sessionId: null,
					appId: null,
					packageId: teamPackageId,
				},
			},
		})

	await expect(resolve()).resolves.toMatchObject({ value: secretValue })
	await t.db
		.prepare(`UPDATE orgs SET deleted_at = ? WHERE id = ?`)
		.bind(now, teamOrgId)
		.run()
	await expect(resolve()).rejects.toMatchObject({ code: 'wrong_org' })

	const rows = await t.auditRows()
	expect(rows.map((row) => [row.org_id, row.result])).toEqual([
		[teamOrgId, 'success'],
		[teamOrgId, 'denied'],
	])
})

test('an actor from another org is denied before any credential read', async () => {
	const t = await setup()
	const otherOrg = ownerIdFromStored(t.memberId) as OwnerId
	const memberInOwnOrg = deriveRequestContext({
		user: { userId: personIdFromStored(t.memberId), username: 'member' },
		source: { kind: 'mcp-oauth' },
		orgBinding: { org: { id: otherOrg, slug: 'member' }, role: 'owner' },
	})
	const error = await denial(t.resolveSecretAs(memberInOwnOrg))
	expect(error).toMatchObject({ code: 'wrong_org' })
	const rows = await t.auditRows()
	expect(rows).toHaveLength(1)
	expect(rows[0]).toMatchObject({ org_id: t.orgId, result: 'denied' })
})

test('a host the secret is not approved for is an audited denial, not a success', async () => {
	const t = await setup()
	const owner = t.personRequest(t.ownerStableId, 'owner', 'owner')
	const resolveForHost = (requestHost: string) =>
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: owner,
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name: 'orgToken',
				storageContext: { sessionId: null, appId: null, packageId: null },
				requestHost,
			},
		})

	const error = await denial(resolveForHost('evil.example'))
	expect(error).toBeInstanceOf(SecretHostNotApprovedError)
	expect(error).toMatchObject({
		secretName: 'orgToken',
		host: 'evil.example',
		scope: 'user',
	})
	expect(String(error)).not.toContain(secretValue)

	await setSecretAllowedHosts({
		env: t.env,
		userId: t.orgId,
		name: 'orgToken',
		scope: 'user',
		allowedHosts: ['api.example.com'],
	})
	await expect(resolveForHost('api.example.com')).resolves.toMatchObject({
		value: secretValue,
	})

	const rows = await t.auditRows()
	expect(rows.map((row) => row.result)).toEqual(['denied', 'success'])
	expect(details(rows[0])).toMatchObject({
		reason: 'SecretHostNotApprovedError',
	})
	expect(JSON.stringify(rows)).not.toContain(secretValue)
})

test('a claimed package stamp is held to vault grants, and an invalid provider id is still audited', async () => {
	const t = await setup()
	const doorSecretName = 'onePasswordServiceAccountToken'
	await t.db
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES ('pkg-provider', ?, 'op', 'op', '', 'source-pkg-provider')`,
		)
		.bind(t.orgId)
		.run()
	await saveSecret({
		env: t.env,
		userId: t.orgId,
		scope: 'user',
		name: doorSecretName,
		value: 'op-sa-token',
	})
	await t.db
		.prepare(
			`INSERT INTO secret_provider_bindings (
				user_id, provider_id, package_id, door_secret_name, config_json
			) VALUES (?, '1password', 'pkg-provider', ?, '{}')`,
		)
		.bind(t.orgId, doorSecretName)
		.run()
	const owner = t.personRequest(t.ownerStableId, 'owner', 'owner')
	const resolveVault = (provider: string) =>
		resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: owner,
			packageStamp: claimedPackageStamp(t.packageId),
			baseUrl: 'https://example.com',
			credential: {
				use: 'provider-secret',
				provider,
				ref: 'i/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/password',
				storageContext: {
					sessionId: null,
					appId: null,
					packageId: t.packageId,
				},
			},
		})

	// The owner has Use on the door key; the claimed package has no grant.
	await expect(resolveVault('1password')).rejects.toBeInstanceOf(
		SecretProviderGrantDeniedError,
	)
	await expect(resolveVault('x'.repeat(65))).rejects.toThrow(/is invalid/)

	const rows = await t.auditRows()
	expect(rows.map((row) => [row.resource_id, row.result])).toEqual([
		['1password', 'denied'],
		['x'.repeat(65), 'failure'],
	])
	expect(details(rows[0])).toMatchObject({
		reason: 'SecretProviderGrantDeniedError',
		packageStampKind: 'claimed',
	})
})

test('a failed org access lookup is retried on the next resolution, not cached', async () => {
	const t = await setup()
	let failNextPrepare = true
	const flakyDb = new Proxy(t.db, {
		get(target, property) {
			if (property === 'prepare' && failNextPrepare) {
				return () => {
					failNextPrepare = false
					throw new Error('D1 unavailable')
				}
			}
			const value = Reflect.get(target, property, target) as unknown
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
	const env = { ...t.env, APP_DB: flakyDb } as Env
	const owner = t.personRequest(t.ownerStableId, 'owner', 'owner')
	const resolve = () =>
		resolveCredential({
			env,
			orgId: t.orgId,
			actor: owner,
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name: 'orgToken',
				storageContext: { sessionId: null, appId: null, packageId: null },
			},
		})

	await expect(resolve()).rejects.toThrow('D1 unavailable')
	await expect(resolve()).resolves.toMatchObject({ value: secretValue })

	const rows = await t.auditRows()
	expect(rows.map((row) => row.result)).toEqual(['failure', 'success'])
})

test('an audit write failure is logged without the value and never fails the resolution', async () => {
	const t = await setup()
	const env = {
		...t.env,
		AUDIT_DB: {
			prepare() {
				throw new Error('audit db unavailable')
			},
		} as unknown as D1Database,
	} as Env
	consoleError.mockImplementation(() => {})
	await expect(
		resolveCredential({
			env,
			orgId: t.orgId,
			actor: t.personRequest(t.ownerStableId, 'owner', 'owner'),
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name: 'orgToken',
				storageContext: { sessionId: null, appId: null, packageId: null },
			},
		}),
	).resolves.toMatchObject({ value: secretValue })
	await Promise.all(scheduledAudits.splice(0))
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(consoleError.mock.calls[0]?.[0]).toBe(
		'Failed to record credential resolution audit event:',
	)
	expect(
		JSON.stringify(consoleError.mock.calls[0]?.[1], (_key, value) =>
			value instanceof Error ? value.message : value,
		),
	).not.toContain(secretValue)
})
