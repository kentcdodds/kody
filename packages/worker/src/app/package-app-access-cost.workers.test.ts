import { env, exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import { createCountingD1 } from '#worker/test-support/counting-d1.ts'
import {
	accessFixture,
	accessFixtureOrigin,
	packageAppAccessAuditRows,
	packageAppSessionCookieFor,
	seedPackageAppAccessFixture,
	type AccessFixturePerson,
} from '#worker/test-support/package-app-access-fixture.ts'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

/**
 * D1 statements the package-app access gate pays per request, for every
 * actor and for HTML vs `/_assets`, on the first request, on a ticket
 * refresh, and while a valid access ticket is presented. The fixture apps have no published
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

function ticketCookieFrom(response: Response) {
	const setCookie = response.headers.get('Set-Cookie') ?? ''
	const match = /(__Host-kody_pkg_ticket_[\w-]+=[^;]+)/.exec(setCookie)
	return match?.[1] ?? null
}

/**
 * `presentTicket`: carry the access ticket from each response into the next
 * request, as a browser does. Otherwise every request is a ticket refresh.
 */
async function measureGate(input: {
	actor: Actor
	kind: Kind
	slug: string
	requests: number
	presentTicket?: boolean
}) {
	const path =
		input.kind === 'html'
			? `/packages/${input.slug}`
			: `/packages/${input.slug}/_assets/app.js`
	const cookie =
		input.actor === 'anonymous'
			? null
			: await packageAppSessionCookieFor(input.actor, input.slug)
	const realDb = env.APP_DB
	const counting = createCountingD1(realDb)
	const mutableEnv = env as unknown as { APP_DB: D1Database }
	mutableEnv.APP_DB = counting.db
	const results: Array<{
		status: number
		gateStatements: number
		mintedTicket: boolean
	}> = []
	let ticket: string | null = null
	try {
		for (let index = 0; index < input.requests; index += 1) {
			counting.reset()
			const cookies = [cookie, input.presentTicket ? ticket : null].filter(
				Boolean,
			)
			const response = await exports.default.fetch(
				new Request(`${accessFixtureOrigin}${path}`, {
					redirect: 'manual',
					headers: cookies.length ? { Cookie: cookies.join('; ') } : {},
				}),
			)
			await response.arrayBuffer()
			const minted = ticketCookieFrom(response)
			if (minted) ticket = minted
			results.push({
				status: response.status,
				gateStatements: counting.statements.filter(
					(sql) => !isServeStatement(sql),
				).length,
				mintedTicket: minted !== null,
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
		firstGateStatements: number
		refreshGateStatements: number
		ticketGateStatements: number
		mintsTicket: boolean
	}> = []
	for (const actor of [
		'owner',
		'member',
		'collaborator',
		'anonymous',
	] as const) {
		for (const kind of ['html', 'asset'] as const) {
			const slug =
				actor === 'anonymous'
					? accessFixture.publicApp.slug
					: accessFixture.privateApp.slug
			const refreshes = await measureGate({ actor, kind, slug, requests: 3 })
			const withTicket = await measureGate({
				actor,
				kind,
				slug,
				requests: 3,
				presentTicket: true,
			})
			measured.push({
				actor,
				kind,
				status: withTicket.at(-1)!.status,
				firstGateStatements: refreshes[0]!.gateStatements,
				refreshGateStatements: Math.max(
					...refreshes.slice(1).map((r) => r.gateStatements),
				),
				ticketGateStatements: Math.max(
					...withTicket.slice(1).map((r) => r.gateStatements),
				),
				mintsTicket: refreshes.every((r) => r.mintedTicket),
			})
		}
	}
	// 500 = cleared the gate and reached serve (no published source seeded).
	// First request (cold isolate, per actor on the HTML leg): the full
	// check — person, org, slug, access_epoch, binding / grant / access_cache —
	// then a ticket is minted. Refresh (ticket expired or absent, decision
	// cached in KV for this epoch): access_epoch only. Valid ticket: nothing.
	// Anonymous on an internet-visible app: handle, slug, and approval are
	// isolate-cached and no ticket is involved.
	const row = (
		actor: Actor,
		kind: Kind,
		firstGateStatements: number,
		refreshGateStatements: number,
	) => ({
		actor,
		kind,
		status: 500,
		firstGateStatements,
		refreshGateStatements,
		ticketGateStatements: 0,
		mintsTicket: actor !== 'anonymous',
	})
	// Owner resolution uses users.deleted_at from findOne (no extra live SQL).
	expect(measured).toEqual([
		row('owner', 'html', 6, 1),
		row('owner', 'asset', 1, 1),
		row('member', 'html', 7, 1),
		row('member', 'asset', 1, 1),
		row('collaborator', 'html', 8, 1),
		row('collaborator', 'asset', 1, 1),
		row('anonymous', 'html', 2, 0),
		row('anonymous', 'asset', 0, 0),
	])

	// Durable row per mint; requests that present a valid ticket log nothing.
	// Per signed-in actor and kind: 3 refreshes + 1 mint before the ticket.
	const mints = await packageAppAccessAuditRows('package_app_ticket_mint')
	expect(mints).toHaveLength(3 * 2 * 4)
	expect(mints[0]).toEqual({
		action: 'package_app_ticket_mint',
		result: 'success',
		path: `/packages/${accessFixture.privateApp.slug}`,
		reason: `${accessFixture.orgSlug}/${accessFixture.privateApp.slug}: role owner, epoch 0`,
	})

	// Anonymous visitors of a private app still stop at the gate.
	const privateAnonymous = await measureGate({
		actor: 'anonymous',
		kind: 'html',
		slug: accessFixture.privateApp.slug,
		requests: 1,
	})
	expect(privateAnonymous[0]?.status).toBe(403)
})
