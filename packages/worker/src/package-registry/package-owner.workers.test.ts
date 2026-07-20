import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createPlatformAccount } from '#app/platform-account-creation.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { resolvePackageOwnerContext } from './package-owner.ts'
import { insertPackageScopeGrant } from './scope-grants.ts'
import { ensurePackageScopeGrantsTestSchema } from './test-schema.ts'

function reservedPlatformUsername() {
	return `kody-r-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
}

function personUsername() {
	return `person-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
}

async function seedPersonUser(input: { username: string; email: string }) {
	const stableUserId = await createStableUserIdFromEmail(input.email)
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

test('resolvePackageOwnerContext returns caller as owner when no scope is requested', async () => {
	await ensurePackageScopeGrantsTestSchema(env.APP_DB)
	const person = await seedPersonUser({
		username: personUsername(),
		email: `owner-${crypto.randomUUID()}@example.com`,
	})
	const user = {
		userId: person.stableUserId,
		email: person.email,
		displayName: person.username,
	}

	const context = await resolvePackageOwnerContext(env.APP_DB, user)
	expect(context).toEqual({
		ownerUserId: person.stableUserId,
		ownerScope: person.username,
		ownerEmail: person.email,
		actorUserId: person.stableUserId,
		delegated: false,
	})
})

test('resolvePackageOwnerContext returns platform owner when a grant exists', async () => {
	await ensurePackageScopeGrantsTestSchema(env.APP_DB)
	const person = await seedPersonUser({
		username: personUsername(),
		email: `grantee-${crypto.randomUUID()}@example.com`,
	})
	const platform = await createPlatformAccount({
		db: env.APP_DB,
		email: `platform-${crypto.randomUUID()}@example.com`,
		username: reservedPlatformUsername(),
	})
	await insertPackageScopeGrant(env.APP_DB, {
		scopeOwnerUserId: platform.stableUserId,
		granteeUserId: person.stableUserId,
		createdByUserId: person.stableUserId,
	})

	const context = await resolvePackageOwnerContext(
		env.APP_DB,
		{
			userId: person.stableUserId,
			email: person.email,
			displayName: person.username,
		},
		platform.username,
	)
	expect(context).toEqual({
		ownerUserId: platform.stableUserId,
		ownerScope: platform.username,
		ownerEmail: platform.email,
		actorUserId: person.stableUserId,
		delegated: true,
	})
})

test('resolvePackageOwnerContext rejects person scopes, missing grants, and unknown scopes', async () => {
	await ensurePackageScopeGrantsTestSchema(env.APP_DB)
	const actor = await seedPersonUser({
		username: personUsername(),
		email: `actor-${crypto.randomUUID()}@example.com`,
	})
	const otherPerson = await seedPersonUser({
		username: personUsername(),
		email: `other-${crypto.randomUUID()}@example.com`,
	})
	const platform = await createPlatformAccount({
		db: env.APP_DB,
		email: `platform-${crypto.randomUUID()}@example.com`,
		username: reservedPlatformUsername(),
	})
	const user = {
		userId: actor.stableUserId,
		email: actor.email,
		displayName: actor.username,
	}

	await expect(
		resolvePackageOwnerContext(env.APP_DB, user, otherPerson.username),
	).rejects.toThrow(/not a platform account scope/)

	await expect(
		resolvePackageOwnerContext(env.APP_DB, user, platform.username),
	).rejects.toThrow(/do not have a package scope grant/)

	await expect(
		resolvePackageOwnerContext(env.APP_DB, user, 'missing-scope-xyz'),
	).rejects.toThrow(/not a platform account scope/)
})
