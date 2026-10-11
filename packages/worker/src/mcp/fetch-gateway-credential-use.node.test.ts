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
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import * as packageSource from '#worker/package-registry/source.ts'
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

function mockPackageManifest(name: string, credentials?: unknown) {
	return vi
		.spyOn(packageSource, 'loadPackageManifestBySourceId')
		.mockResolvedValue({
			source: {} as packageSource.LoadedPackageManifest['source'],
			manifest: parseAuthoredPackageJson({
				content: JSON.stringify({
					name,
					exports: { '.': './index.ts' },
					kody: { description: 'Test package.', credentials },
				}),
				mode: 'published',
			}),
		})
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
		}).then(({ request: expanded }) => expanded)

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
		}).then(({ request: expanded }) => expanded)

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
	mockPackageManifest('@ownera/notes')
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
	expect(packageAuthoritySecret.request.headers.get('Authorization')).toBe(
		'Bearer pkg-secret-value',
	)
})

test('leak: a declared package credential is refused outside its placement, in the URL, or over plain HTTP, before it resolves', async () => {
	const db = await createOrgDb()
	const ownerStableId = testStableUserIdFromEmail('owner-p@example.com')
	const ownerId = ownerIdFromStored(ownerStableId)
	const now = '2026-10-11T00:00:00.000Z'
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'ownerp',
		createdAt: now,
	})
	const packageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: ownerId,
			name: '@ownerp/mailer',
			kody_id: 'mailer',
			description: 'mailer',
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
	const manifestSpy = mockPackageManifest('@ownerp/mailer', {
		RESEND_API_KEY: {
			kind: 'secret',
			provider: 'resend',
			description: 'Resend API key.',
			placement: { header: 'Authorization', template: 'Bearer {value}' },
		},
		GOOGLE: { kind: 'oauth', provider: 'google', description: 'Google.' },
		CLIENT_ID: {
			kind: 'secret',
			provider: 'acme',
			description: 'Acme client id.',
			placement: { header: 'Authorization' },
		},
		CLIENT_SECRET: {
			kind: 'secret',
			provider: 'acme',
			description: 'Acme client secret.',
			placement: { header: 'Authorization', template: 'Basic {value}' },
		},
	})
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue(userSecret('resend-secret-value', ['api.resend.com']))
	const tokenSpy = vi
		.spyOn(integrationCredentials, 'resolveIntegrationAccessToken')
		.mockResolvedValue('google-access')
	vi.spyOn(
		integrationPackageAccess,
		'assertCanUseIntegration',
	).mockResolvedValue(undefined)
	vi.spyOn(integrationService, 'getJoinedIntegration').mockResolvedValue({
		lane: 'user',
		app: { apiBaseUrl: 'https://api.resend.com' },
		connection: { requiredHosts: ['api.resend.com'] },
	} as never)

	const ownerRequest = deriveRequestContext({
		user: { userId: personIdFromStored(ownerStableId), username: 'ownerp' },
		source: { kind: 'mcp-oauth' },
		orgBinding: { org: { id: ownerId, slug: 'ownerp' }, role: 'owner' },
	})
	const env = {
		APP_DB: db,
		...createInMemoryUserMeterEnv().env,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const expandAsPackage = (url: string, init: RequestInit = {}) =>
		expandSecretPlaceholders({
			request: new Request(url, init),
			props: {
				baseUrl: 'https://example.com',
				userId: ownerId,
				email: null,
				request: ownerRequest,
				storageContext: {
					sessionId: null,
					appId: packageId,
					packageId,
					storageId: packageId,
				},
				grantedSecretAuthorityPackageIds: [packageId],
			},
			env,
		}).then(({ request: expanded }) => expanded)
	const refusal = async (url: string, init: RequestInit = {}) =>
		String(
			await expandAsPackage(url, init).then(
				() => {
					throw new Error(`Expected ${url} to be refused.`)
				},
				(error: unknown) => error,
			),
		)

	const sent = await expandAsPackage('https://api.resend.com/emails', {
		headers: { Authorization: 'Bearer {{secret:RESEND_API_KEY}}' },
	})
	expect(sent.headers.get('Authorization')).toBe('Bearer resend-secret-value')
	const google = await expandAsPackage('https://api.resend.com/emails', {
		headers: { Authorization: 'Bearer {{integration-token:GOOGLE}}' },
	})
	expect(google.headers.get('Authorization')).toBe('Bearer google-access')
	const basicPair = '{{secret-basic:username=CLIENT_ID,password=CLIENT_SECRET}}'
	const basic = await expandAsPackage('https://api.resend.com/token', {
		headers: { Authorization: `Basic ${basicPair}` },
	})
	expect(basic.headers.get('Authorization')).toBe(
		`Basic ${btoa('resend-secret-value:resend-secret-value')}`,
	)
	resolveSpy.mockClear()
	tokenSpy.mockClear()

	// Outside the declared header or template.
	expect(
		await refusal('https://api.resend.com/emails', {
			headers: { 'X-Api-Key': '{{secret:RESEND_API_KEY}}' },
		}),
	).toContain(
		'Slot "RESEND_API_KEY" of @ownerp/mailer may only be sent in its declared header "Authorization" (as "Bearer {value}"), not in "x-api-key".',
	)
	expect(
		await refusal('https://api.resend.com/emails', {
			headers: { Authorization: 'Token {{secret:RESEND_API_KEY}}' },
		}),
	).toContain(
		'Slot "RESEND_API_KEY" of @ownerp/mailer must be sent as "Authorization: Bearer {value}"',
	)
	expect(
		await refusal('https://api.resend.com/emails', {
			headers: { Authorization: 'bearer {{secret:RESEND_API_KEY}}' },
		}),
	).toContain('must be sent as "Authorization: Bearer {value}"')
	expect(
		await refusal('https://api.resend.com/token', {
			headers: { Authorization: `X Basic ${basicPair}` },
		}),
	).toContain(
		`Header "authorization" must be exactly "Basic ${basicPair}" to send slots of @ownerp/mailer as Basic Auth.`,
	)
	expect(
		await refusal('https://api.resend.com/token', {
			headers: {
				Authorization:
					'Basic {{secret-basic:username=CLIENT_ID,password=RESEND_API_KEY}}',
			},
		}),
	).toContain(
		'Slot "RESEND_API_KEY" of @ownerp/mailer declares template "Bearer {value}", but a Basic Auth pair is sent as "Basic {value}".',
	)
	expect(
		await refusal('https://api.resend.com/emails', {
			headers: { 'X-Token': 'Bearer {{integration-token:GOOGLE}}' },
		}),
	).toContain(
		'Slot "GOOGLE" of @ownerp/mailer may only be sent in its declared header "Authorization"',
	)
	expect(
		await refusal('https://api.resend.com/emails', {
			headers: { Authorization: 'Bearer {{secret:OTHER_KEY}}' },
		}),
	).toContain('"OTHER_KEY" is not a kody.credentials slot of @ownerp/mailer.')
	expect(
		await refusal('https://api.resend.com/emails', {
			headers: { Authorization: 'Bearer {{secret:GOOGLE}}' },
		}),
	).toContain(
		'Slot "GOOGLE" of @ownerp/mailer has kind "oauth", but {{secret:GOOGLE}} needs a slot of kind "secret".',
	)

	// Outside every header: URL and query.
	expect(
		await refusal(
			'https://api.resend.com/emails?key={{secret:RESEND_API_KEY}}',
		),
	).toContain('Secret "RESEND_API_KEY" is in the request URL.')

	// Plain HTTP, even in the declared header.
	expect(
		await refusal('http://api.resend.com/emails', {
			headers: { Authorization: 'Bearer {{secret:RESEND_API_KEY}}' },
		}),
	).toContain(
		'Secret "RESEND_API_KEY" cannot be sent over plain HTTP. The fetch gateway substitutes secrets only over HTTPS.',
	)

	expect(resolveSpy).not.toHaveBeenCalled()
	expect(tokenSpy).not.toHaveBeenCalled()
	// One manifest read per run, however many fetches it makes.
	expect(manifestSpy).toHaveBeenCalledTimes(1)
})

test('leak: a published slot that fails the slot schema is refused with its error, and its valid siblings still send', async () => {
	const db = await createOrgDb()
	const ownerStableId = testStableUserIdFromEmail('owner-q@example.com')
	const ownerId = ownerIdFromStored(ownerStableId)
	const now = '2026-10-11T00:00:00.000Z'
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'ownerq',
		createdAt: now,
	})
	const packageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: ownerId,
			name: '@ownerq/mailer',
			kody_id: 'mailer',
			description: 'mailer',
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
	mockPackageManifest('@ownerq/mailer', {
		RESEND_API_KEY: {
			kind: 'secret',
			provider: 'resend',
			description: 'Resend API key.',
			placement: { header: 'X-Kody-Key' },
		},
		GOOGLE: { kind: 'oauth', provider: 'google', description: 'Google.' },
	})
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue(userSecret('resend-secret-value', ['api.resend.com']))
	vi.spyOn(
		integrationCredentials,
		'resolveIntegrationAccessToken',
	).mockResolvedValue('google-access')
	vi.spyOn(
		integrationPackageAccess,
		'assertCanUseIntegration',
	).mockResolvedValue(undefined)
	vi.spyOn(integrationService, 'getJoinedIntegration').mockResolvedValue({
		lane: 'user',
		app: { apiBaseUrl: 'https://api.resend.com' },
		connection: { requiredHosts: ['api.resend.com'] },
	} as never)
	const env = {
		APP_DB: db,
		...createInMemoryUserMeterEnv().env,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const expandAsPackage = (headers: Record<string, string>) =>
		expandSecretPlaceholders({
			request: new Request('https://api.resend.com/emails', { headers }),
			props: {
				baseUrl: 'https://example.com',
				userId: ownerId,
				email: null,
				request: deriveRequestContext({
					user: {
						userId: personIdFromStored(ownerStableId),
						username: 'ownerq',
					},
					source: { kind: 'mcp-oauth' },
					orgBinding: { org: { id: ownerId, slug: 'ownerq' }, role: 'owner' },
				}),
				storageContext: {
					sessionId: null,
					appId: packageId,
					packageId,
					storageId: packageId,
				},
				grantedSecretAuthorityPackageIds: [packageId],
			},
			env,
		}).then(({ request: expanded }) => expanded)

	const google = await expandAsPackage({
		Authorization: 'Bearer {{integration-token:GOOGLE}}',
	})
	expect(google.headers.get('Authorization')).toBe('Bearer google-access')

	const refusal = await expandAsPackage({
		'X-Kody-Key': '{{secret:RESEND_API_KEY}}',
	}).then(
		() => {
			throw new Error('Expected the invalid slot to be refused.')
		},
		(error: unknown) => String(error),
	)
	expect(refusal).toContain(
		'Slot "RESEND_API_KEY" of @ownerq/mailer is invalid in its published package.json, so the fetch gateway does not substitute it:\nkody.credentials.RESEND_API_KEY.placement.header: x-kody-* headers are reserved for Kody.\nFix the slot and publish again.',
	)
	// The package stays declared: an undeclared name is still refused.
	await expect(
		expandAsPackage({ 'X-Api-Key': '{{secret:OTHER_KEY}}' }),
	).rejects.toThrow(
		'"OTHER_KEY" is not a kody.credentials slot of @ownerq/mailer.',
	)
	expect(resolveSpy).not.toHaveBeenCalled()
})
