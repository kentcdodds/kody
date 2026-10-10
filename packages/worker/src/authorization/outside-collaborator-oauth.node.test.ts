import { DatabaseSync } from 'node:sqlite'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { listPackagesCapability } from '#mcp/capabilities/packages/list-packages.ts'
import { packageUpdateCapability } from '#mcp/capabilities/packages/package-update.ts'
import {
	createMcpCallerContext,
	parseMcpCallerContext,
	toMcpCallerContextWire,
} from '#mcp/context.ts'
import { loadOrgBindingFromGrantProps } from '#worker/orgs/grant-binding.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	AuthorizationError,
	authorize,
	computeEffectivePermissions,
	packageResource,
} from './authorize.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return db
}

test('an OAuth outside collaborator can do only what their grant allows', async () => {
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('gus@example.com')
	const collaboratorId = testStableUserIdFromEmail('ada@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'gus',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	await provisionPersonalOrg(db, {
		stableUserId: collaboratorId,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	const grantedPackageId = crypto.randomUUID()
	const otherPackageId = crypto.randomUUID()
	const now = '2026-01-04T00:00:00.000Z'
	for (const pkg of [
		{
			id: grantedPackageId,
			name: '@gus/notes',
			kodyId: 'notes',
		},
		{
			id: otherPackageId,
			name: '@gus/ledger',
			kodyId: 'ledger',
		},
	]) {
		await insertSavedPackage(
			db,
			{
				id: pkg.id,
				user_id: ownerId,
				name: pkg.name,
				kody_id: pkg.kodyId,
				description: 'notes',
				tags_json: '[]',
				search_text: null,
				source_id: `source-${pkg.id}`,
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
	}
	const grant = await upsertGrant({
		db,
		orgId: ownerId,
		resourceType: 'package',
		resourceId: grantedPackageId,
		subject: { type: 'user', id: collaboratorId },
		preset: 'use',
		permissions: null,
		createdByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
	})
	expect(grant.permissions).toEqual(['package:read', 'package:execute'])

	const binding = await loadOrgBindingFromGrantProps({
		db,
		personId: collaboratorId,
		grantProps: { orgId: ownerId, userId: collaboratorId },
	})
	expect(binding).toEqual({
		org: { id: ownerId, slug: 'gus' },
		role: null,
	})

	const connected = parseMcpCallerContext(
		toMcpCallerContextWire(
			createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored(collaboratorId),
					email: 'ada@example.com',
					displayName: 'Ada',
					username: 'ada',
				},
				orgBinding: binding,
			}),
		),
		{ kind: 'mcp-oauth' },
	)
	const request = connected.request
	if (!request) throw new Error('Expected an OAuth request context.')
	expect(request.membership).toBeNull()
	expect(request.org).toEqual({ id: ownerId, slug: 'gus' })
	expect(request.credential.kind).toBe('mcp-oauth')
	expect(request.actor?.userId).toBe(collaboratorId)

	const env = { APP_DB: db } as Env
	const ctx = { env, callerContext: connected }
	const access = await computeEffectivePermissions({ env, request })
	expect(access.isOwner).toBe(false)
	expect([...access.permissions].sort()).toEqual(['org:execute', 'search:read'])
	const grantedPermissions = access.resourcePermissions.get(
		`package:${grantedPackageId}`,
	)
	expect([...(grantedPermissions ?? [])].sort()).toEqual([
		'package:execute',
		'package:read',
	])
	expect(access.resourcePermissions.has(`package:${otherPackageId}`)).toBe(
		false,
	)

	const grantedResource = packageResource({
		id: grantedPackageId,
		userId: ownerId,
		label: '@gus/notes',
	})
	const otherResource = packageResource({
		id: otherPackageId,
		userId: ownerId,
		label: '@gus/ledger',
	})
	await authorize({ env, request }, 'package:read', grantedResource)
	await authorize({ env, request }, 'package:execute', grantedResource)
	await authorize({ env, request }, 'search:read')
	await authorize({ env, request }, 'org:execute')

	const listed = await listPackagesCapability.handler({}, ctx)
	expect(listed.packages.map((pkg) => pkg.package_id)).toEqual([
		grantedPackageId,
	])

	const denied = async (
		permission:
			| 'package:read'
			| 'package:write'
			| 'package:delete'
			| 'package:create'
			| 'member:read'
			| 'org:read'
			| 'org:write',
		resource?: typeof grantedResource,
	) => {
		const error = await authorize({ env, request }, permission, resource).catch(
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(AuthorizationError)
		expect(error).toMatchObject({
			code: 'missing_permission',
			permission,
		})
	}
	await denied('package:read', otherResource)
	await denied('package:write', grantedResource)
	await denied('package:delete', grantedResource)
	await denied('package:create')
	await denied('member:read')
	await denied('org:read')
	await denied('org:write')

	const updateError = await packageUpdateCapability
		.handler({ package_id: grantedPackageId, changes: { hidden: true } }, ctx)
		.catch((caught: unknown) => caught)
	expect(updateError).toBeInstanceOf(AuthorizationError)
	expect(updateError).toMatchObject({
		code: 'missing_permission',
		permission: 'package:write',
	})
	const hidden = await db
		.prepare(`SELECT hidden FROM saved_packages WHERE id = ?`)
		.bind(grantedPackageId)
		.first<{ hidden: number }>()
	expect(hidden?.hidden).toBe(0)
})
