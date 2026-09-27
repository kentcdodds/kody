import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { AppSessionProvider } from '#client/app-session-context.tsx'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'
import { AccountCreditsRoute } from '#client/routes/account-credits.tsx'
import { type SessionInfo } from '#client/session.ts'
import { type AccountCreditsLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'

const session: SessionInfo = {
	email: 'jane@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	username: 'jane',
	avatarUrl: null,
	roles: [],
	permissions: [],
	featureFlags: {} as SessionInfo['featureFlags'],
}

function credits(
	overrides: Partial<AccountCreditsLoaderData> = {},
): AccountCreditsLoaderData {
	return {
		ok: true,
		configured: true,
		eligible: true,
		plan: 'pro',
		canSwitchToPro: true,
		canBuyCredits: true,
		billingHref: '/account/billing',
		balanceMicroUsd: 18_420_000,
		unlocked: true,
		packsCents: [1_000, 2_500, 5_000],
		customMinCents: 500,
		customMaxCents: 50_000,
		autoRefill: {
			enabled: false,
			thresholdCents: null,
			amountCents: null,
			monthlyCapCents: null,
			minThresholdCents: 500,
			refilledThisMonthCents: 0,
			hasPaymentMethod: false,
		},
		notify: { autoRefilled: true, monthlyCap: true, lowBalance: true },
		limits: [
			{
				resource: 'execute_calls_per_day',
				label: 'Execute calls per day',
				base: 1_500,
				unlocked: 75_000,
			},
		],
		rates: [
			{
				meter: 'unique_worker_days',
				label: '$0.004 per worker-compute day',
			},
			{
				meter: 'durable_object_rows_read',
				label: '$0.002 per million rows read',
			},
		],
		recent: [
			{
				id: 'entry-1',
				kind: 'top_up',
				amountMicroUsd: 25_000_000,
				description: 'Top-up',
				createdAt: '2026-09-20T10:00:00.000Z',
			},
			{
				id: 'entry-2',
				kind: 'debit',
				amountMicroUsd: -6_580_000,
				description: 'Worker compute (1,645)',
				createdAt: '2026-09-21T10:00:00.000Z',
			},
		],
		...overrides,
	}
}

function renderCreditsPage(accountCredits: AccountCreditsLoaderData) {
	return renderToString(
		jsx(RouterLocationProvider, {
			url: routes.accountCredits.href(),
			children: jsx(AppSessionProvider, {
				session,
				status: 'ready',
				children: jsx(AppLoaderDataProvider, {
					loaderData: { accountCredits },
					children: jsx(AccountCreditsRoute, {}),
				}),
			}),
		}),
	)
}

test('eligible wallet shows balance, packs, limits, rates, and recent activity', async () => {
	const html = await renderCreditsPage(credits())
	expect(html).toContain('$18.42')
	expect(html).toContain('Higher limits are on.')
	for (const pack of ['$10', '$25', '$50']) expect(html).toContain(`>${pack}<`)
	expect(html).toContain('With $0')
	expect(html).toContain('With credits')
	expect(html).toContain('75,000')
	expect(html).toContain(
		'$0.004 per worker-compute day · $0.002 per million rows read',
	)
	expect(html).not.toContain('unique worker day')
	expect(html).toContain('+$25.00')
	expect(html).toContain('−$6.58')
	expect(html).toContain('Worker compute (1,645)')
	expect(html).toContain('Balance at or below $5')
	expect(html).not.toContain('Hit monthly cap')
	expect(html).not.toMatch(/\bMax\b/)
})

test('auto-refill on shows its settings, cap notices, and the card note', async () => {
	const html = await renderCreditsPage(
		credits({
			balanceMicroUsd: -120_000,
			unlocked: false,
			autoRefill: {
				enabled: true,
				thresholdCents: 500,
				amountCents: 2_500,
				monthlyCapCents: 10_000,
				minThresholdCents: 500,
				refilledThisMonthCents: 2_500,
				hasPaymentMethod: false,
			},
		}),
	)
	expect(html).toContain('−$0.12')
	expect(html).toContain('Add credits to lift your limits.')
	expect(html).toContain('value="25"')
	expect(html).toContain('value="100"')
	expect(html).toContain('Auto-refilled')
	expect(html).toContain('Hit monthly cap')
	expect(html).not.toContain('Balance at or below $5')
	expect(html).toContain(
		'Auto-refill starts after your first top-up saves a card.',
	)
})

test('ineligible accounts get one switch-to-Pro prompt', async () => {
	const html = await renderCreditsPage(
		credits({ eligible: false, plan: 'standard', unlocked: false }),
	)
	expect(html).toContain('Credits are available on Pro.')
	expect(html).toContain('Switch to Pro')
	expect(html).not.toContain('With credits')

	const noCheckout = await renderCreditsPage(
		credits({ eligible: false, plan: 'free', canSwitchToPro: false }),
	)
	expect(noCheckout).toMatch(/href="\/account\/billing"[^>]*>Go to billing</)
	expect(noCheckout).not.toContain('>Switch to Pro<')
})

test('gift and referral Pro overlays are ineligible for the credits wallet', async () => {
	const html = await renderCreditsPage(
		credits({
			eligible: false,
			plan: 'pro',
			canBuyCredits: false,
			canSwitchToPro: true,
			balanceMicroUsd: 0,
			unlocked: false,
		}),
	)
	expect(html).toContain('Credits are available on Pro.')
	expect(html).toContain('Switch to Pro')
	expect(html).not.toContain('With credits')
	expect(html).not.toContain('Subscribe to Pro to add credits.')
})
