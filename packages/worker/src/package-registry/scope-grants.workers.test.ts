import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	createPlatformAccount,
	type PlatformAccountCreateError,
} from '#app/platform-account-creation.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { adminPackageScopeGrantCreateCapability } from '#mcp/capabilities/admin/admin-package-scope-grant-create.ts'
import { adminPackageScopeGrantListCapability } from '#mcp/capabilities/admin/admin-package-scope-grant-list.ts'
import { adminPackageScopeGrantRevokeCapability } from '#mcp/capabilities/admin/admin-package-scope-grant-revoke.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { insertPackageScopeGrant } from './scope-grants.ts'
import { ensurePackageScopeGrantsTestSchema } from './test-schema.ts'

function reservedPlatformUsername() {
	return `kody-r-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
}

function personUsername() {
	return `person-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
}

async function seedPersonUser(input: {
	username: string
	email: string
	stableUserId?: string
}) {
	const stableUserId =
		input.stableUserId ?? (await createStableUserIdFromEmail(input.email))
	const result = await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, account_type)
		 VALUES (?, ?, 'test-password-hash', ?, ?, 'person')`,
	)
		.bind(input.username, input.email, new Date().toISOString(), stableUserId)
		.run()
	return {
		id: result.meta.last_row_id as number,
		username: input.username,
		email: input.email,
		stableUserId,
	}
}

function createAdminCapabilityContext(input: {
	userId: string
	email: string
}) {
	return {
		env: { APP_DB: env.APP_DB } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: input.userId,
				email: input.email,
				displayName: 'admin',
				roles: ['admin'],
			},
		}),
	}
}

test('createPlatformAccount rejects non-reserved usernames and duplicates; creates platform rows', async () => {
	await ensurePackageScopeGrantsTestSchema(env.APP_DB)
	const email = `platform-${crypto.randomUUID()}@example.com`
	const username = reservedPlatformUsername()

	await expect(
		createPlatformAccount({
			db: env.APP_DB,
			email,
			username: 'not-reserved-user',
		}),
	).rejects.toMatchObject({
		code: 'invalid_username',
		message: 'Platform accounts may only claim reserved usernames.',
	} satisfies Partial<PlatformAccountCreateError>)

	const created = await createPlatformAccount({
		db: env.APP_DB,
		email,
		username,
	})
	expect(created).toMatchObject({
		email,
		username,
		userId: expect.any(Number),
		stableUserId: expect.any(String),
	})

	const row = await env.APP_DB.prepare(
		`SELECT account_type, password_hash, username, email, plan FROM users WHERE id = ?`,
	)
		.bind(created.userId)
		.first<{
			account_type: string
			password_hash: string
			username: string
			email: string
			plan: string | null
		}>()
	expect(row).toEqual({
		account_type: 'platform',
		password_hash: 'platform_account_no_usable_password',
		username,
		email,
		plan: 'unlimited',
	})

	await expect(
		createPlatformAccount({
			db: env.APP_DB,
			email,
			username: reservedPlatformUsername(),
		}),
	).rejects.toMatchObject({ code: 'email_exists' })

	await expect(
		createPlatformAccount({
			db: env.APP_DB,
			email: `other-${crypto.randomUUID()}@example.com`,
			username,
		}),
	).rejects.toMatchObject({ code: 'username_exists' })
})

test('admin package scope grant create, list, and revoke handlers', async () => {
	await ensurePackageScopeGrantsTestSchema(env.APP_DB)
	const adminEmail = `admin-${crypto.randomUUID()}@example.com`
	const admin = await seedPersonUser({
		username: personUsername(),
		email: adminEmail,
	})
	const platform = await createPlatformAccount({
		db: env.APP_DB,
		email: `platform-${crypto.randomUUID()}@example.com`,
		username: reservedPlatformUsername(),
	})
	const grantee = await seedPersonUser({
		username: personUsername(),
		email: `grantee-${crypto.randomUUID()}@example.com`,
	})
	const otherPerson = await seedPersonUser({
		username: personUsername(),
		email: `other-${crypto.randomUUID()}@example.com`,
	})
	const ctx = createAdminCapabilityContext({
		userId: admin.stableUserId,
		email: adminEmail,
	})

	await expect(
		insertPackageScopeGrant(env.APP_DB, {
			scopeOwnerUserId: otherPerson.stableUserId,
			granteeUserId: grantee.stableUserId,
			createdByUserId: admin.stableUserId,
		}),
	).rejects.toThrow(
		'Package scope grants can only be created on platform accounts.',
	)

	const created = await adminPackageScopeGrantCreateCapability.handler(
		{ scope: platform.username, username: grantee.username },
		ctx,
	)
	expect(created).toEqual({
		created: true,
		scope: platform.username,
		username: grantee.username,
	})

	const createdAgain = await adminPackageScopeGrantCreateCapability.handler(
		{ scope: platform.username, username: grantee.username },
		ctx,
	)
	expect(createdAgain.created).toBe(false)

	await expect(
		adminPackageScopeGrantCreateCapability.handler(
			{ scope: otherPerson.username, username: grantee.username },
			ctx,
		),
	).rejects.toThrow(/only possible on platform accounts/)

	const listed = await adminPackageScopeGrantListCapability.handler(
		{ scope: platform.username },
		ctx,
	)
	expect(listed.grants).toEqual([
		expect.objectContaining({
			scope: platform.username,
			username: grantee.username,
			created_by_user_id: admin.stableUserId,
			created_at: expect.any(String),
		}),
	])

	const revoked = await adminPackageScopeGrantRevokeCapability.handler(
		{ scope: platform.username, username: grantee.username },
		ctx,
	)
	expect(revoked).toEqual({
		deleted: true,
		scope: platform.username,
		username: grantee.username,
	})

	const revokedAgain = await adminPackageScopeGrantRevokeCapability.handler(
		{ scope: platform.username, username: grantee.username },
		ctx,
	)
	expect(revokedAgain.deleted).toBe(false)

	const listedAfter = await adminPackageScopeGrantListCapability.handler(
		{ scope: platform.username },
		ctx,
	)
	expect(listedAfter.grants).toEqual([])
})
