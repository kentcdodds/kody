import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createPlatformAccount } from '#worker/identity/platform-account-creation.ts'
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
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, account_type, plan)
		 VALUES (?, ?, 'test-password-hash', ?, ?, 'person', 'max')`,
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

test('resolvePackageOwnerContext returns caller ownership, grant delegation, and rejection paths', async () => {
	await ensurePackageScopeGrantsTestSchema(env.APP_DB)
	const person = await seedPersonUser({
		username: personUsername(),
		email: `owner-${crypto.randomUUID()}@example.com`,
	})
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
	const personUser = {
		userId: person.stableUserId,
		email: person.email,
		displayName: person.username,
	}
	const actorUser = {
		userId: actor.stableUserId,
		email: actor.email,
		displayName: actor.username,
	}

	expect(await resolvePackageOwnerContext(env.APP_DB, personUser)).toEqual({
		ownerUserId: person.stableUserId,
		ownerScope: person.username,
		ownerEmail: person.email,
		actorUserId: person.stableUserId,
		delegated: false,
	})

	await insertPackageScopeGrant(env.APP_DB, {
		scopeOwnerUserId: platform.stableUserId,
		granteeUserId: person.stableUserId,
		createdByUserId: person.stableUserId,
	})
	expect(
		await resolvePackageOwnerContext(env.APP_DB, personUser, platform.username),
	).toEqual({
		ownerUserId: platform.stableUserId,
		ownerScope: platform.username,
		ownerEmail: platform.email,
		actorUserId: person.stableUserId,
		delegated: true,
	})

	await expect(
		resolvePackageOwnerContext(env.APP_DB, actorUser, otherPerson.username),
	).rejects.toThrow(/not a platform account scope/)

	await expect(
		resolvePackageOwnerContext(env.APP_DB, actorUser, platform.username),
	).rejects.toThrow(/do not have a package scope grant/)

	await expect(
		resolvePackageOwnerContext(env.APP_DB, actorUser, 'missing-scope-xyz'),
	).rejects.toThrow(/not a platform account scope/)

	// Email on the caller context can drift (for example mid-request email
	// change) while stable_user_id stays authoritative — package scope must
	// still resolve from identity, not email.
	const staleEmail = `stale-${crypto.randomUUID()}@example.com`
	expect(
		await resolvePackageOwnerContext(env.APP_DB, {
			userId: person.stableUserId,
			email: staleEmail,
			displayName: person.username,
		}),
	).toEqual({
		ownerUserId: person.stableUserId,
		ownerScope: person.username,
		ownerEmail: staleEmail,
		actorUserId: person.stableUserId,
		delegated: false,
	})
})
