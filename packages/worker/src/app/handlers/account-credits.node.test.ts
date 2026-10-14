import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { creditTopUpSuccessUrl } from '#worker/billing/credit-top-ups.ts'
import {
	accountCreditsRedirectUrl,
	createAccountCreditsHandler,
} from './account-credits.ts'

const mockModule = vi.hoisted(() => ({
	requireAuthenticatedPageUser: vi.fn<() => Promise<unknown>>(),
	getOrgById: vi.fn<(db: unknown, id: string) => Promise<unknown>>(),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: () => mockModule.requireAuthenticatedPageUser(),
}))

vi.mock('#worker/orgs/repo.ts', () => ({
	getOrgById: (db: unknown, id: string) => mockModule.getOrgById(db, id),
}))

const env = { APP_DB: {} } as Env

beforeEach(() => {
	vi.clearAllMocks()
	mockModule.requireAuthenticatedPageUser.mockResolvedValue({
		userId: 7,
		username: 'ada',
		mcpUser: { userId: ownerIdFromStored('stable-7') },
	})
	mockModule.getOrgById.mockResolvedValue({ slug: 'ada' })
})

test('old /account/credits links land on the personal org usage Credits section', async () => {
	const request = new Request('https://kody.codes/account/credits')
	const response = await createAccountCreditsHandler(env).handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe(
		'https://kody.codes/@ada/-/usage#credits',
	)
})

test('the redirect keeps pre-move Stripe returns and notice codes', () => {
	expect(
		accountCreditsRedirectUrl(
			'https://kody.codes/account/credits?topup=success&session_id=cs_123',
			'ada',
		),
	).toBe(
		'https://kody.codes/@ada/-/usage?topup=success&session_id=cs_123#credits',
	)
	expect(
		accountCreditsRedirectUrl(
			'https://kody.codes/account/credits?credits=added',
			'ada',
		),
	).toBe('https://kody.codes/@ada/-/usage?credits=added#credits')
})

test('top-up success URL drops the fragment so Stripe can append the session id', () => {
	expect(creditTopUpSuccessUrl('https://kody.codes/@ada/-/usage#credits')).toBe(
		'https://kody.codes/@ada/-/usage?topup=success&session_id={CHECKOUT_SESSION_ID}',
	)
})
