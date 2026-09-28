import { beforeEach, expect, test, vi } from 'vitest'
import type * as CreditTopUps from '#worker/billing/credit-top-ups.ts'
import { CreditTopUpError } from '#worker/billing/credit-top-ups.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { createAccountUsageHandler } from './account-usage.ts'

const mockModule = vi.hoisted(() => ({
	requireAuthenticatedPageUser: vi.fn<() => Promise<unknown>>(),
	loadAccountUsageData: vi.fn<(input: unknown) => Promise<unknown>>(),
	applyCreditTopUpFromCheckoutSession:
		vi.fn<(input: unknown) => Promise<unknown>>(),
	renderAppPage: vi.fn(async ({ loaderData }: { loaderData?: unknown }) =>
		Response.json({ ok: true, loaderData }),
	),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: () => mockModule.requireAuthenticatedPageUser(),
}))

vi.mock('#app/account-usage-data.ts', () => ({
	loadAccountUsageData: (input: unknown) =>
		mockModule.loadAccountUsageData(input),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (input: { loaderData?: unknown }) =>
		mockModule.renderAppPage(input),
}))

vi.mock('#worker/billing/credit-top-ups.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof CreditTopUps>()
	return {
		...actual,
		applyCreditTopUpFromCheckoutSession: (input: unknown) =>
			mockModule.applyCreditTopUpFromCheckoutSession(input),
	}
})

const env = {} as Env

beforeEach(() => {
	vi.clearAllMocks()
	mockModule.requireAuthenticatedPageUser.mockResolvedValue({
		userId: 7,
		mcpUser: { userId: 'stable-7' },
	})
	mockModule.loadAccountUsageData.mockResolvedValue({ ok: true })
})

async function getUsage(search: string) {
	const request = new Request(`https://kody.codes/account/usage${search}`)
	return createAccountUsageHandler(env).handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

test('a confirmed Stripe return lands on the Credits section with the added notice', async () => {
	const response = await getUsage('?topup=success&session_id=cs_123')
	expect(mockModule.applyCreditTopUpFromCheckoutSession).toHaveBeenCalledWith(
		expect.objectContaining({
			sessionId: 'cs_123',
			expectedStableUserId: 'stable-7',
		}),
	)
	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe(
		'https://kody.codes/account/usage?credits=added#credits',
	)
})

test('a rejected Stripe return keeps known codes and folds the rest into topup_failed', async () => {
	consoleError.mockImplementation(() => {})
	mockModule.applyCreditTopUpFromCheckoutSession.mockRejectedValueOnce(
		new CreditTopUpError('not_paid', 'Not paid.'),
	)
	const notPaid = await getUsage('?topup=success&session_id=cs_1')
	expect(notPaid.headers.get('Location')).toBe(
		'https://kody.codes/account/usage?error=not_paid#credits',
	)

	mockModule.applyCreditTopUpFromCheckoutSession.mockRejectedValueOnce(
		new CreditTopUpError('user_not_found', 'Missing.'),
	)
	const unknown = await getUsage('?topup=success&session_id=cs_2')
	expect(unknown.headers.get('Location')).toBe(
		'https://kody.codes/account/usage?error=topup_failed#credits',
	)
	expect(consoleError.mock.calls.map(([message]) => message)).toEqual([
		'credit_top_up_confirm_failed',
		'credit_top_up_confirm_failed',
	])
})

test('notice and error codes map to messages; unknown and prototype keys map to nothing', async () => {
	await getUsage('?credits=added&error=not_paid')
	expect(mockModule.loadAccountUsageData).toHaveBeenLastCalledWith(
		expect.objectContaining({
			notice:
				'Credits added. Usage past your monthly include runs on them within a minute.',
			error: 'That top-up has not been paid yet.',
		}),
	)

	await getUsage('?credits=__proto__&error=constructor')
	expect(mockModule.loadAccountUsageData).toHaveBeenLastCalledWith(
		expect.objectContaining({ notice: undefined, error: undefined }),
	)
	expect(mockModule.applyCreditTopUpFromCheckoutSession).not.toHaveBeenCalled()
})
