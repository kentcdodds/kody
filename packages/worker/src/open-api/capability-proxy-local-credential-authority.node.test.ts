/**
 * Real-boundary: CapabilityProxy (CLI execute --local) must not treat a
 * client-claimed package id as secret authority. A member with package:execute
 * on org package P but without secret:use / integration:use must not expand
 * org credentials by stamping P on gatewayFetch.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import * as secretService from '#mcp/secrets/service.ts'
import * as integrationCredentials from '#worker/integrations/credentials.ts'
import * as integrationPackageAccess from '#worker/integrations/package-access.ts'
import * as integrationService from '#worker/integrations/service.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { runCapabilityProxyGatewayFetch } from './capability-proxy-gateway-fetch.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

async function createOrgDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return db
}

function userSecret(
	value: string,
	allowedHosts: Array<string>,
): secretService.ResolvedSecret {
	return {
		found: true,
		value,
		scope: 'user',
		allowedHosts,
		allowedPackages: [],
	}
}

test('local CapabilityProxy package stamp does not skip secret:use / integration:use', async () => {
	const db = await createOrgDb()
	const ownerStableId = testStableUserIdFromEmail('owner-a@example.com')
	const ownerId = ownerIdFromStored(ownerStableId)
	const memberId = testStableUserIdFromEmail('member-b@example.com')
	const now = '2026-10-10T00:00:00.000Z'
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'ownera',
		createdAt: now,
	})
	await provisionPersonalOrg(db, {
		stableUserId: memberId,
		username: 'memberb',
		createdAt: now,
	})
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(ownerId, memberId, now)
		.run()
	const packageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: ownerId,
			name: '@ownera/notes',
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
	await upsertGrant({
		db,
		orgId: ownerId,
		resourceType: 'package',
		resourceId: packageId,
		subject: { type: 'user', id: memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
	})

	const userMeter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: db,
		...userMeter.env,
		COOKIE_SECRET: 'test-cookie-secret',
	} as unknown as Env

	vi.spyOn(secretService, 'resolveSecret').mockResolvedValue(
		userSecret('org-secret-value', ['example.com']),
	)
	vi.spyOn(
		integrationPackageAccess,
		'assertCanUseIntegration',
	).mockResolvedValue(undefined)
	vi.spyOn(
		integrationCredentials,
		'resolveIntegrationAccessToken',
	).mockResolvedValue('oauth-access')
	vi.spyOn(integrationService, 'getJoinedIntegration').mockResolvedValue({
		lane: 'user',
		app: { apiBaseUrl: 'https://example.com' },
		connection: { requiredHosts: ['example.com'] },
	} as never)

	const memberRequest = deriveRequestContext({
		user: {
			userId: personIdFromStored(memberId),
			username: 'memberb',
		},
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: ownerId, slug: 'ownera' },
			role: 'member',
		},
	})

	const buildCtx = (request: typeof memberRequest) =>
		({
			env,
			callerContext: {
				baseUrl: 'https://example.com',
				user: {
					userId: personIdFromStored(memberId),
					email: 'member-b@example.com',
				},
				request,
				storageContext: null,
			},
			waitUntil: undefined,
		}) as never

	const secretDenied = await runCapabilityProxyGatewayFetch({
		ctx: buildCtx(memberRequest),
		args: [
			{
				packageId,
				request: {
					url: 'https://example.com/',
					headers: {
						authorization: 'Bearer {{secret:orgEcho|scope=user}}',
					},
				},
			},
		],
	}).then(
		() => null,
		(error: unknown) => error,
	)
	expect(secretDenied).toBeInstanceOf(AuthorizationError)
	expect(String(secretDenied)).toMatch(/Missing secret:use/)

	const integrationDenied = await runCapabilityProxyGatewayFetch({
		ctx: buildCtx(memberRequest),
		args: [
			{
				packageId,
				request: {
					url: 'https://example.com/',
					headers: {
						authorization: 'Bearer {{integration-token:orgGoogle}}',
					},
				},
			},
		],
	}).then(
		() => null,
		(error: unknown) => error,
	)
	expect(integrationDenied).toBeInstanceOf(AuthorizationError)
	expect(String(integrationDenied)).toMatch(/Missing integration:use/)

	// Claiming a package without package:execute still fails closed.
	const otherPackageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: otherPackageId,
			user_id: ownerId,
			name: '@ownera/other',
			kody_id: 'other',
			description: 'other',
			tags_json: '[]',
			search_text: null,
			source_id: `source-${otherPackageId}`,
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
	await expect(
		runCapabilityProxyGatewayFetch({
			ctx: buildCtx(memberRequest),
			args: [
				{
					packageId: otherPackageId,
					request: {
						url: 'https://example.com/',
						headers: {
							authorization: 'Bearer {{secret:orgEcho|scope=user}}',
						},
					},
				},
			],
		}),
	).rejects.toThrow(/package/i)

	// After secret:use grant, stamped local hop expands (ad-hoc Use, not package
	// attachment).
	await upsertGrant({
		db,
		orgId: ownerId,
		resourceType: 'secret',
		resourceId: 'orgEcho',
		subject: { type: 'user', id: memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
	})
	// Fresh request context so compiled permissions include the new grant.
	const memberAfterGrant = deriveRequestContext({
		user: {
			userId: personIdFromStored(memberId),
			username: 'memberb',
		},
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: ownerId, slug: 'ownera' },
			role: 'member',
		},
	})
	const granted = await runCapabilityProxyGatewayFetch({
		ctx: buildCtx(memberAfterGrant),
		args: [
			{
				packageId,
				request: {
					url: 'https://example.com/',
					headers: {
						authorization: 'Bearer {{secret:orgEcho|scope=user}}',
					},
				},
			},
		],
	})
	expect(granted.status).toBe(200)
})
