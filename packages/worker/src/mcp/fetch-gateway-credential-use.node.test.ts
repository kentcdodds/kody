/**
 * Real-boundary coverage: expandSecretPlaceholders → authorize for ambient
 * credential use. Member / outside collaborator without secret:use or
 * integration:use must not expand org placeholders; Owners and granted
 * actors may. Package authority keeps package attachment (not this gate).
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
import { expandSecretPlaceholders } from '#mcp/fetch-gateway.ts'
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

test('ambient fetch placeholders require secret:use / integration:use for members and outside collaborators', async () => {
	const db = await createOrgDb()
	const ownerStableId = testStableUserIdFromEmail('owner-a@example.com')
	const ownerId = ownerIdFromStored(ownerStableId)
	const memberId = testStableUserIdFromEmail('member-b@example.com')
	const collaboratorId = testStableUserIdFromEmail('collab-c@example.com')
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
	await provisionPersonalOrg(db, {
		stableUserId: collaboratorId,
		username: 'collabc',
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
		subject: { type: 'user', id: collaboratorId },
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
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
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

	const secretRequest = () =>
		new Request('https://example.com/api', {
			headers: { Authorization: 'Bearer {{secret:orgEcho}}' },
		})
	const integrationRequest = () =>
		new Request('https://example.com/api', {
			headers: {
				Authorization: 'Bearer {{integration-token:orgGoogle}}',
			},
		})

	const ownerRequest = deriveRequestContext({
		user: {
			userId: personIdFromStored(ownerStableId),
			username: 'ownera',
		},
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: ownerId, slug: 'ownera' },
			role: 'owner',
		},
	})
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
	const collaboratorRequest = deriveRequestContext({
		user: {
			userId: personIdFromStored(collaboratorId),
			username: 'collabc',
		},
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: ownerId, slug: 'ownera' },
			role: null,
		},
	})

	const expandFor = (request: typeof ownerRequest) =>
		expandSecretPlaceholders({
			request: secretRequest(),
			props: {
				baseUrl: 'https://example.com',
				userId: ownerId,
				email: null,
				request,
				storageContext: null,
			},
			env,
		})

	const expandIntegrationFor = (request: typeof ownerRequest) =>
		expandSecretPlaceholders({
			request: integrationRequest(),
			props: {
				baseUrl: 'https://example.com',
				userId: ownerId,
				email: null,
				request,
				storageContext: null,
			},
			env,
		})

	// Owner A: ambient placeholders resolve.
	const ownerSecret = await expandFor(ownerRequest)
	expect(ownerSecret.headers.get('Authorization')).toBe(
		'Bearer org-secret-value',
	)
	const ownerIntegration = await expandIntegrationFor(ownerRequest)
	expect(ownerIntegration.headers.get('Authorization')).toBe(
		'Bearer oauth-access',
	)

	// Member B (no grants): denied with the missing permission named.
	const memberSecretError = await expandFor(memberRequest).then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(memberSecretError).toBeInstanceOf(AuthorizationError)
	expect(memberSecretError).toMatchObject({
		code: 'missing_permission',
		permission: 'secret:use',
		resource: expect.objectContaining({
			type: 'secret',
			id: 'orgEcho',
		}),
	})
	expect(String(memberSecretError)).toMatch(/Missing secret:use/)

	const memberIntegrationError = await expandIntegrationFor(memberRequest).then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(memberIntegrationError).toBeInstanceOf(AuthorizationError)
	expect(memberIntegrationError).toMatchObject({
		code: 'missing_permission',
		permission: 'integration:use',
		resource: expect.objectContaining({
			type: 'integration',
			id: 'orgGoogle',
		}),
	})
	expect(String(memberIntegrationError)).toMatch(/Missing integration:use/)

	// Outside collaborator C (package Use only): same denials.
	const collabSecretError = await expandFor(collaboratorRequest).then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(collabSecretError).toBeInstanceOf(AuthorizationError)
	expect(collabSecretError).toMatchObject({
		code: 'missing_permission',
		permission: 'secret:use',
	})
	const collabIntegrationError = await expandIntegrationFor(
		collaboratorRequest,
	).then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(collabIntegrationError).toBeInstanceOf(AuthorizationError)
	expect(collabIntegrationError).toMatchObject({
		code: 'missing_permission',
		permission: 'integration:use',
	})

	// Grant secret:use / integration:use on those resources → member may use.
	// Fresh request contexts: effective permissions are cached per request
	// object, so reusing the pre-grant memberRequest would keep the denial.
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
	await upsertGrant({
		db,
		orgId: ownerId,
		resourceType: 'integration',
		resourceId: 'orgGoogle',
		subject: { type: 'user', id: memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
	})
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
	const grantedSecret = await expandFor(memberAfterGrant)
	expect(grantedSecret.headers.get('Authorization')).toBe(
		'Bearer org-secret-value',
	)
	const grantedIntegration = await expandIntegrationFor(memberAfterGrant)
	expect(grantedIntegration.headers.get('Authorization')).toBe(
		'Bearer oauth-access',
	)

	// Package authority still expands without a secret:use grant (self-authored
	// package attachment). Collaborator C has no secret grant; package
	// authority skips the ambient gate.
	vi.mocked(secretService.resolveSecret).mockResolvedValue(
		userSecret('pkg-secret-value', ['example.com']),
	)
	const packageAuthoritySecret = await expandSecretPlaceholders({
		request: secretRequest(),
		props: {
			baseUrl: 'https://example.com',
			userId: ownerId,
			email: null,
			request: collaboratorRequest,
			storageContext: {
				sessionId: null,
				appId: packageId,
				packageId,
				storageId: packageId,
			},
			// Bundled package runs pass provenance grants; omit → empty set
			// still keeps runPackageId as authority when no stamp header.
			grantedSecretAuthorityPackageIds: [packageId],
		},
		env,
	})
	expect(packageAuthoritySecret.headers.get('Authorization')).toBe(
		'Bearer pkg-secret-value',
	)
})
