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
import {
	includedComputeSummary,
	presentIncludedCompute,
	resolveCreditsAlarm,
	toAccountActivity,
} from '#universal/usage-presentation.ts'

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

const sampleDebitMeters: AccountCreditsLoaderData['debitMeters'] = [
	{
		meter: 'unique_worker_days',
		label: 'Worker compute',
		unitRateLabel: '$0.004 per worker-compute day',
		include: 350,
		used: 1_995,
		pastInclude: 1_645,
		percentOfInclude: 1_995 / 350,
		estCreditsMicroUsd: 6_580_000,
	},
	{
		meter: 'durable_object_rows_read',
		label: 'Rows read',
		unitRateLabel: '$0.002 per million rows read',
		include: 5_000_000_000,
		used: 1_200_000_000,
		pastInclude: 0,
		percentOfInclude: 1_200_000_000 / 5_000_000_000,
		estCreditsMicroUsd: 0,
	},
]

const pastIncludeFunded = presentIncludedCompute({
	plan: 'pro',
	creditWallet: 'funded',
	meters: [
		{ resource: 'unique_worker_days', current: 1_995, include: 350 },
		{
			resource: 'durable_object_rows_read',
			current: 1_200_000_000,
			include: 5_000_000_000,
		},
	],
})

function credits(
	overrides: Partial<AccountCreditsLoaderData> = {},
): AccountCreditsLoaderData {
	return {
		activity: toAccountActivity({
			month: '2026-09',
			counts: {
				execute: 4_812,
				job_run: 96,
				workflow_run: 12,
				package_export: 310,
			},
		}),
		includedCompute: pastIncludeFunded,
		includedComputeSummary: includedComputeSummary({
			plan: 'pro',
			creditWallet: 'funded',
			meters: pastIncludeFunded,
		}),
		creditsAlarm: null,
		ok: true,
		configured: true,
		eligible: true,
		plan: 'pro',
		canSwitchToPro: true,
		canBuyCredits: true,
		billingHref: '/account/billing',
		balanceMicroUsd: 18_420_000,
		hasCredits: true,
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
				included: 500,
				creditsCeiling: 25_000,
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
		debitMeters: sampleDebitMeters,
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

test('eligible wallet shows balance, packs, limits, rate card, and recent activity', async () => {
	const html = await renderCreditsPage(credits())
	expect(html).toContain('$18.42')
	expect(html).toContain(
		'Usage past your monthly include is charged from these credits.',
	)
	for (const pack of ['$10', '$25', '$50']) expect(html).toContain(`>${pack}<`)
	expect(html).toContain('How far credits go')
	expect(html).toContain('>Included<')
	expect(html).toContain('On credits, up to')
	expect(html).toContain('25,000')
	expect(html).toContain(
		'Usage within the monthly include is free. Past it, credits pay these rates until they run out; then usage past the include stops.',
	)
	expect(html).toContain('How credits are charged')
	expect(html).toContain('data-credits-rate-card')
	expect(html).toContain('data-credits-rate-card-stack')
	expect(html).toContain('<table')
	expect(html).toContain('@media (max-width: 640px)')
	expect(html).toContain('Worker compute')
	expect(html).toContain('Rows read')
	expect(html).toContain('$0.004 per worker-compute day')
	expect(html).toContain('$0.002 per million rows read')
	expect(html).toContain('Monthly include')
	expect(html).toContain('Used this period')
	expect(html).toContain('Past include')
	expect(html).toContain('Est. credits this period')
	expect(html).toContain('1,645')
	expect(html).toContain('$6.58')
	expect(html).toContain('+$25.00')
	expect(html).toContain('−$6.58')
	expect(html).toContain('Worker compute (1,645)')
	expect(html).toContain('Balance at or below $5')
	expect(html).not.toContain('Hit monthly cap')
})

test('rate card keeps sub-cent estimated credits visible', async () => {
	const html = await renderCreditsPage(
		credits({
			debitMeters: [
				{
					meter: 'unique_worker_days',
					label: 'Worker compute',
					unitRateLabel: '$0.004 per worker-compute day',
					include: 350,
					used: 351,
					pastInclude: 1,
					percentOfInclude: 351 / 350,
					estCreditsMicroUsd: 4_000,
				},
			],
			recent: [],
		}),
	)
	expect(html).toContain('>$0.004<')
})

test('auto-refill on shows its settings, cap notices, and the card note', async () => {
	const html = await renderCreditsPage(
		credits({
			balanceMicroUsd: -120_000,
			hasCredits: false,
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
	expect(html).toContain(
		'With no credits left, usage past your monthly include stops. Add credits to keep going.',
	)
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
		credits({ eligible: false, plan: 'standard', hasCredits: false }),
	)
	expect(html).toContain('Credits are available on Pro.')
	expect(html).toContain('Switch to Pro')
	expect(html).not.toContain('How far credits go')
	expect(html).not.toContain('How credits are charged')

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
			hasCredits: false,
		}),
	)
	expect(html).toContain('Credits are available on Pro.')
	expect(html).toContain('Switch to Pro')
	expect(html).not.toContain('How far credits go')
	expect(html).not.toContain('Subscribe to Pro to add credits.')
})

const overHundredPercent = /\b(?:1(?:0[1-9]|[1-9]\d)|[2-9]\d\d|\d{4,})%/

function visibleText(html: string) {
	return html
		.replaceAll(/<style[\s\S]*?<\/style>/g, ' ')
		.replaceAll(/<script[\s\S]*?<\/script>/g, ' ')
		.replaceAll(/<[^>]+>/g, ' ')
}

test('Pro past include: activity first, bar capped at 100%, calm dollars on credits, no alarm', async () => {
	const html = await renderCreditsPage(credits())
	const text = visibleText(html)
	expect(html).toContain('Activity this month')
	expect(html).toContain('Code executions')
	expect(html).toContain('4,812')
	expect(text).toContain('September 2026')
	expect(text).toContain('Packages and triggers keep work warm')
	expect(html).toContain('Included compute')
	expect(html).toContain('data-included-compute-bar="100"')
	expect(html).toContain('data-included-compute-tone="calm"')
	expect(text).toContain('Include used · $6.58 on credits')
	expect(text).toContain('1,995 of 350 worker-compute days included')
	expect(text).toContain(
		"Past this month's include, usage runs on credits: $6.58 so far.",
	)
	expect(html).not.toContain('data-credits-alarm')
	expect(html.indexOf('Activity this month')).toBeLessThan(
		html.indexOf('Included compute'),
	)
	expect(text).not.toMatch(overHundredPercent)
})

test('credits alarm shows only when the wallet is at risk past the include', async () => {
	const pastIncludeEmpty = presentIncludedCompute({
		plan: 'pro',
		creditWallet: 'empty',
		meters: [{ resource: 'unique_worker_days', current: 400, include: 350 }],
	})
	const html = await renderCreditsPage(
		credits({
			balanceMicroUsd: 0,
			hasCredits: false,
			includedCompute: pastIncludeEmpty,
			creditsAlarm: resolveCreditsAlarm({
				creditWallet: 'empty',
				meters: pastIncludeEmpty,
				balanceMicroUsd: 0,
				canBuyCredits: true,
				autoRefill: null,
			}),
		}),
	)
	expect(html).toContain('data-credits-alarm="include_used_no_credits"')
	expect(html).toContain('Runs past the include are stopped')
	expect(html).toContain('data-included-compute-tone="attention"')
	expect(html).toContain('data-included-compute-bar="100"')
	expect(visibleText(html)).not.toMatch(overHundredPercent)
})
