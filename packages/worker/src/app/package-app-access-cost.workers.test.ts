import { env, exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import { createCountingD1 } from '#worker/test-support/counting-d1.ts'
import {
	accessFixture,
	accessFixtureOrigin,
	packageAppSessionCookieFor,
	seedPackageAppAccessFixture,
	type AccessFixturePerson,
} from '#worker/test-support/package-app-access-fixture.ts'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

/**
 * D1 statements the package-app access gate pays per request, for every
 * actor and for HTML vs `/_assets`. The fixture apps have no published
 * source, so a request that clears the gate ends in serve's host-setup 500;
 * the manifest read that fails there (`entity_sources`, cached once a source
 * exists) is serve's cost, not the gate's, and is left out of the count.
 */

type Actor = AccessFixturePerson | 'anonymous'
type Kind = 'html' | 'asset'

function configureOrigins() {
	const mutableEnv = env as unknown as Record<string, string | undefined>
	mutableEnv.APP_BASE_URL = 'https://app.kody.test:8788'
	mutableEnv.PACKAGE_APP_BASE_URL = 'https://packages.isolated.test'
	mutableEnv.SENTRY_ENVIRONMENT = 'production'
}

function isServeStatement(sql: string) {
	return sql.includes('FROM entity_sources')
}

async function measureGate(input: {
	actor: Actor
	kind: Kind
	slug: string
	requests: number
}) {
	const path =
		input.kind === 'html'
			? `/packages/${input.slug}`
			: `/packages/${input.slug}/_assets/app.js`
	const cookie =
		input.actor === 'anonymous'
			? null
			: await packageAppSessionCookieFor(input.actor)
	const realDb = env.APP_DB
	const counting = createCountingD1(realDb)
	const mutableEnv = env as unknown as { APP_DB: D1Database }
	mutableEnv.APP_DB = counting.db
	const results: Array<{ status: number; gateStatements: number }> = []
	try {
		for (let index = 0; index < input.requests; index += 1) {
			counting.reset()
			const response = await exports.default.fetch(
				new Request(`${accessFixtureOrigin}${path}`, {
					redirect: 'manual',
					headers: cookie ? { Cookie: cookie } : {},
				}),
			)
			await response.arrayBuffer()
			results.push({
				status: response.status,
				gateStatements: counting.statements.filter(
					(sql) => !isServeStatement(sql),
				).length,
			})
		}
	} finally {
		mutableEnv.APP_DB = realDb
	}
	return results
}

test('package-app access gate D1 statements per actor and request kind', async () => {
	silenceExpectedConsoleErrors([
		'Package app handler failed:',
		'Package app asset handler failed:',
		'package-app-http-error',
	])
	configureOrigins()
	setAuthSessionSecret(env.COOKIE_SECRET)
	await seedPackageAppAccessFixture()
	for (const person of Object.values(accessFixture.people)) {
		invalidatePackageAppOwnerCache({
			stableUserId: testStableUserIdFromEmail(person.email),
		})
	}

	const measured: Array<{
		actor: Actor
		kind: Kind
		status: number
		warmGateStatements: number
	}> = []
	for (const actor of [
		'owner',
		'member',
		'collaborator',
		'anonymous',
	] as const) {
		for (const kind of ['html', 'asset'] as const) {
			const results = await measureGate({
				actor,
				kind,
				slug:
					actor === 'anonymous'
						? accessFixture.publicApp.slug
						: accessFixture.privateApp.slug,
				requests: 3,
			})
			const warm = results.slice(1)
			measured.push({
				actor,
				kind,
				status: results.at(-1)!.status,
				warmGateStatements: Math.max(...warm.map((r) => r.gateStatements)),
			})
		}
	}

	// 500 = cleared the gate and reached serve (no published source seeded).
	// Owner: org binding. Member: binding, access_epoch, access_cache.
	// Outside collaborator: membership miss, grant probe, epoch, cache.
	// Anonymous on an internet-visible app: handle and slug are isolate-cached.
	const gate = (actor: Actor, warmGateStatements: number) =>
		(['html', 'asset'] as const).map((kind) => ({
			actor,
			kind,
			status: 500,
			warmGateStatements,
		}))
	expect(measured).toEqual([
		...gate('owner', 1),
		...gate('member', 3),
		...gate('collaborator', 4),
		...gate('anonymous', 0),
	])

	// Anonymous visitors of a private app still stop at the gate.
	const privateAnonymous = await measureGate({
		actor: 'anonymous',
		kind: 'html',
		slug: accessFixture.privateApp.slug,
		requests: 1,
	})
	expect(privateAnonymous[0]?.status).toBe(403)
})
