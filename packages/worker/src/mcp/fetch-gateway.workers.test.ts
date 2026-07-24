import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { incrementDailyEntitlementCounter } from '#worker/entitlements/service.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

test('gateway fetches consume the daily outbound-fetch entitlement and deny over the plan limit', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEntitlementTestSchema(env.APP_DB)
	const email = `fetcher-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `fetcher-${crypto.randomUUID().slice(0, 8)}`,
		plan: 'free',
		stableUserId: userId,
	})
	const props = {
		baseUrl: 'https://kody.example.com',
		userId,
		email,
		storageContext: null,
	}
	const globalFetch = (async () =>
		new Response('ok')) as unknown as typeof fetch

	const allowed = await executeGatewayFetch({
		env,
		props,
		request: new Request('https://api.example.net/data'),
		globalFetch,
	})
	expect(await allowed.text()).toBe('ok')
	const counter = await env.APP_DB.prepare(
		`SELECT count FROM entitlement_daily_counters
		 WHERE user_id = ? AND resource = 'outbound_fetches_per_day' AND day = ?`,
	)
		.bind(userId, utcDayKey())
		.first<{ count: number }>()
	expect(Number(counter?.count)).toBe(1)

	// Fill the remaining free-plan quota, then expect denial.
	await incrementDailyEntitlementCounter({
		db: env.APP_DB,
		userId,
		resource: 'outbound_fetches_per_day',
		amount: planLimits.free.maxOutboundFetchesPerDay - 1,
	})
	const denied = await executeGatewayFetch({
		env,
		props,
		request: new Request('https://api.example.net/data'),
		globalFetch,
	}).catch((error: unknown) => error)
	expect(isEntitlementLimitError(denied)).toBe(true)

	// Callers that carry no email (OpenAPI provider requests, package
	// runtime) still bind to the caller's real plan: the gateway
	// reverse-resolves the account from the stable userId instead of
	// failing open to the `max` quota.
	const deniedWithoutEmail = await executeGatewayFetch({
		env,
		props: { ...props, email: null },
		request: new Request('https://api.example.net/data'),
		globalFetch,
	}).catch((error: unknown) => error)
	expect(isEntitlementLimitError(deniedWithoutEmail)).toBe(true)

	// Contextless fetches (no userId) are not metered against a user and
	// pass through without consuming any counter.
	const contextless = await executeGatewayFetch({
		env,
		props: { ...props, userId: null, email: null },
		request: new Request('https://api.example.net/data'),
		globalFetch,
	})
	expect(await contextless.text()).toBe('ok')
})
