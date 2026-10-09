import { DatabaseSync } from 'node:sqlite'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import { createBillingLinkReference } from '#worker/billing/billing-config.ts'
import {
	annualPromoRejection,
	existingSubscriptionPromoRejection,
	promoRejectedByStripe,
} from '#worker/billing/checkout-promo.ts'
import type * as StripeClient from '#worker/billing/stripe-client.ts'
import { StripeApiError } from '#worker/billing/stripe-client.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	requireAuthenticatedPageUser: vi.fn(),
	userHasMcpOAuthGrants: vi.fn(async () => false),
	linkStripeCustomerFromCheckoutSessionAttribution:
		vi.fn<(...args: Array<unknown>) => Promise<unknown>>(),
	loadAccountBillingData: vi.fn(async (input: Record<string, unknown>) => ({
		ok: true,
		org: input.org,
		canManage: input.canManage,
		seats: input.seats,
	})),
	createCheckoutSession:
		vi.fn<(...args: Array<unknown>) => Promise<{ id: string; url: string }>>(),
	createBillingPortalSession:
		vi.fn<(...args: Array<unknown>) => Promise<{ url: string }>>(),
	listSubscriptions:
		vi.fn<(...args: Array<unknown>) => Promise<Array<unknown>>>(),
	findActivePromotionCode:
		vi.fn<(...args: Array<unknown>) => Promise<unknown>>(),
	renderAppPage: vi.fn(
		async (input: {
			loaderData?: unknown
			status?: number
			notFound?: boolean
			unauthorized?: boolean
		}) =>
			Response.json(
				{
					loaderData: input.loaderData ?? null,
					notFound: input.notFound ?? false,
					unauthorized: input.unauthorized ?? false,
				},
				{ status: input.status ?? 200 },
			),
	),
	submitPlatformFeedback:
		vi.fn<(...args: Array<unknown>) => Promise<{ id: string }>>(),
	enqueuePlatformFeedbackDispatch:
		vi.fn<(...args: Array<unknown>) => Promise<void>>(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mocks.requireAuthenticatedPageUser(...args),
}))
vi.mock('#app/onboarding-data.ts', () => ({
	userHasMcpOAuthGrants: () => mocks.userHasMcpOAuthGrants(),
}))
vi.mock('#app/account-billing-data.ts', () => ({
	loadAccountBillingData: (input: Record<string, unknown>) =>
		mocks.loadAccountBillingData(input),
}))
vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (input: never) => mocks.renderAppPage(input),
}))
vi.mock('#worker/billing/subscription-sync.ts', () => ({
	BillingLinkError: class BillingLinkError extends Error {
		readonly code: string
		constructor(code: string, message: string) {
			super(message)
			this.code = code
		}
	},
	linkStripeCustomerFromCheckoutSessionAttribution: (...args: Array<unknown>) =>
		mocks.linkStripeCustomerFromCheckoutSessionAttribution(...args),
}))
vi.mock('#worker/platform-feedback/service.ts', () => ({
	submitPlatformFeedback: (...args: Array<unknown>) =>
		mocks.submitPlatformFeedback(...args),
}))
vi.mock('#worker/platform-feedback/dispatch-queue-producer.ts', () => ({
	enqueuePlatformFeedbackDispatch: (...args: Array<unknown>) =>
		mocks.enqueuePlatformFeedbackDispatch(...args),
}))
vi.mock('#worker/billing/stripe-client.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof StripeClient>()
	return {
		...actual,
		createCheckoutSession: (...args: Array<unknown>) =>
			mocks.createCheckoutSession(...args),
		createBillingPortalSession: (...args: Array<unknown>) =>
			mocks.createBillingPortalSession(...args),
		listSubscriptions: (...args: Array<unknown>) =>
			mocks.listSubscriptions(...args),
		findActivePromotionCode: (...args: Array<unknown>) =>
			mocks.findActivePromotionCode(...args),
	}
})

const {
	createAccountBillingCancellationFeedbackApiHandler,
	createAccountBillingRedirectHandler,
	createOrgBillingApiHandler,
	createOrgBillingCheckoutApiHandler,
	createOrgBillingPortalHandler,
	createOrgBillingSuccessHandler,
} = await import('./org-billing.ts')

const retiredStandardPriceId = 'price_1U3sg6LAQpAnsYszGeL2nc8O'
const now = '2026-01-01T00:00:00.000Z'

/** Personal org per person, plus `acme` where Ada owns, Bob is a member, and Cara is billing. */
const people = {
	ada: { id: 9, personId: 'person-ada' },
	bob: { id: 10, personId: 'person-bob' },
	cara: { id: 11, personId: 'person-cara' },
	dan: { id: 12, personId: 'person-dan' },
} as const
type Person = keyof typeof people

let sqlite: DatabaseSync
let db: D1Database

async function seed() {
	sqlite = new DatabaseSync(':memory:')
	db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({ db, columns: ['stripe_customer_id'] })
	for (const [username, person] of Object.entries(people)) {
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, stable_user_id)
				 VALUES (?, ?, ?, 'x', ?)`,
			)
			.run(person.id, username, `${username}@example.com`, person.personId)
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
				 VALUES (?, ?, NULL, ?, ?)`,
			)
			.run(person.personId, username, now, now)
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`,
			)
			.run(person.personId, person.personId, now)
	}
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES ('org-acme', 'acme', 'Acme', ?, ?)`,
		)
		.run(now, now)
	for (const [person, role] of [
		['ada', 'owner'],
		['bob', 'member'],
		['cara', 'billing'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES ('org-acme', ?, ?, ?)`,
			)
			.run(people[person].personId, role, now)
	}
}

function linkCustomer(orgId: string, customerId: string) {
	sqlite
		.prepare(`UPDATE orgs SET stripe_customer_id = ? WHERE id = ?`)
		.run(customerId, orgId)
	sqlite
		.prepare(`UPDATE users SET stripe_customer_id = ? WHERE stable_user_id = ?`)
		.run(customerId, orgId)
}

function createEnv(overrides: Record<string, unknown> = {}) {
	return {
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
		STRIPE_SECRET_KEY: 'sk_test_secret',
		STRIPE_PRO_PRICE_ID: 'price_pro',
		STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
		APP_DB: db,
		...overrides,
	} as unknown as Env
}

/**
 * Mirrors `readAuthenticatedAppUser`: the request context binds the org the
 * URL names (real resolution against the seeded tables), falling back to
 * the signup org.
 */
function signInAs(person: Person | null) {
	const sign = async (request: Request, env: Env) => {
		if (!person) return null
		const { id, personId } = people[person]
		const mcpUser = {
			userId: personIdFromStored(personId),
			email: `${person}@example.com`,
			displayName: person,
		}
		const resolution = await loadRequestOrgResolution(request, env, personId)
		const orgBinding =
			typeof resolution === 'string'
				? {
						org: { id: personId as never, slug: person },
						role: 'owner' as const,
					}
				: resolution
		return {
			sessionUserId: String(id),
			userId: id,
			username: person,
			email: mcpUser.email,
			emailVerified: true,
			emailVerificationDelivery: null,
			displayName: person,
			roles: ['user'],
			permissions: [],
			artifactOwnerIds: [String(id)],
			mcpUser,
			request: deriveRequestContext({
				user: mcpUser,
				source: { kind: 'session' },
				orgBinding,
			}),
		} satisfies AuthenticatedAppUser
	}
	mocks.readAuthenticatedAppUser.mockImplementation(sign)
	mocks.requireAuthenticatedPageUser.mockImplementation(
		async (request: Request, env: Env) =>
			(await sign(request, env)) ??
			Response.redirect('https://example.com/login', 302),
	)
}

function call(
	createHandler: (env: Env) => { handler: (input: never) => unknown },
	env: Env,
	path: string,
	init?: RequestInit,
) {
	const url = new URL(`https://example.com${path}`)
	return createHandler(env).handler({
		request: new Request(url, init),
		params: {},
		url,
	} as never) as Promise<Response>
}

function postCheckout(env: Env, orgSlug: string, body: unknown) {
	return call(
		createOrgBillingCheckoutApiHandler,
		env,
		`/@${orgSlug}/billing/checkout.json`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		},
	)
}

function subscription(input: { id: string; status: string; priceId: string }) {
	return {
		id: input.id,
		status: input.status,
		cancel_at: null,
		items: { data: [{ id: `si_${input.id}`, price: { id: input.priceId } }] },
	}
}

beforeEach(async () => {
	vi.clearAllMocks()
	await seed()
	mocks.createCheckoutSession.mockResolvedValue({
		id: 'cs_test',
		url: 'https://checkout.stripe.com/c/pay/cs_test',
	})
	mocks.createBillingPortalSession.mockResolvedValue({
		url: 'https://billing.stripe.com/p/session/test',
	})
	mocks.listSubscriptions.mockResolvedValue([])
	mocks.findActivePromotionCode.mockResolvedValue(null)
})

test('checkout sells only Pro and picks the monthly or annual price', async () => {
	signInAs(null)
	const unauthorized = await postCheckout(createEnv(), 'ada', { plan: 'pro' })
	expect(unauthorized.status).toBe(401)

	signInAs('ada')
	for (const body of [
		{},
		{ plan: 'standard' },
		{ plan: 'pro', interval: 'week' },
	]) {
		const response = await postCheckout(createEnv(), 'ada', body)
		expect([body, response.status]).toEqual([body, 400])
	}

	const env = createEnv()
	const monthly = await postCheckout(env, 'ada', { plan: 'pro' })
	expect(monthly.status).toBe(200)
	expect(await monthly.json()).toEqual({
		ok: true,
		url: 'https://checkout.stripe.com/c/pay/cs_test',
		mode: 'checkout',
	})
	expect(mocks.listSubscriptions).not.toHaveBeenCalled()
	expect(mocks.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.objectContaining({
			priceId: 'price_pro',
			customerEmail: 'ada@example.com',
			quantity: 1,
			successUrl:
				'https://example.com/@ada/billing/success?session_id={CHECKOUT_SESSION_ID}',
			cancelUrl: 'https://example.com/@ada/billing',
		}),
	)

	await postCheckout(env, 'ada', { plan: 'pro', interval: 'year' })
	expect(mocks.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.objectContaining({ priceId: 'price_pro_yearly' }),
	)

	const yearlyMissing = await postCheckout(
		createEnv({ STRIPE_PRO_YEARLY_PRICE_ID: '' }),
		'ada',
		{ plan: 'pro', interval: 'year' },
	)
	expect(yearlyMissing.status).toBe(409)
	expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(2)
})

test('an owner subscribes the team org in the URL with one seat per owner and member', async () => {
	signInAs('ada')
	const env = createEnv()
	const response = await postCheckout(env, 'acme', { plan: 'pro' })
	expect(response.status).toBe(200)
	expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
		env,
		expect.objectContaining({
			clientReferenceId: await createBillingLinkReference(env, 'org-acme'),
			metadata: expect.objectContaining({ kody_org_id: 'org-acme' }),
			// Ada (owner) and Bob (member); Cara's billing role is not a seat.
			quantity: 2,
			customerEmail: 'ada@example.com',
			successUrl:
				'https://example.com/@acme/billing/success?session_id={CHECKOUT_SESSION_ID}',
			cancelUrl: 'https://example.com/@acme/billing',
		}),
	)
})

test('only owners and billing admins can subscribe an organization', async () => {
	const env = createEnv()

	signInAs('cara')
	const billingAdmin = await postCheckout(env, 'acme', { plan: 'pro' })
	expect(billingAdmin.status).toBe(200)
	expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(1)

	signInAs('bob')
	const member = await postCheckout(env, 'acme', { plan: 'pro' })
	expect(member.status).toBe(403)
	expect(await member.json()).toEqual({
		ok: false,
		error: 'Only owners and billing admins can manage billing for @acme.',
	})

	// Not a member and no grant: the org is unavailable. It must never fall
	// back to Dan's own signup organization.
	signInAs('dan')
	const outsider = await postCheckout(env, 'acme', { plan: 'pro' })
	expect(outsider.status).toBe(404)
	expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(1)
	expect(mocks.listSubscriptions).not.toHaveBeenCalled()
})

test('promo codes apply to monthly checkouts only, as a Kody-validated discount', async () => {
	signInAs('ada')
	const env = createEnv()

	const annual = await postCheckout(env, 'acme', {
		plan: 'pro',
		interval: 'year',
		promoCode: 'AGENCY-1',
	})
	expect(annual.status).toBe(400)
	expect(await annual.json()).toEqual({
		ok: false,
		error: annualPromoRejection,
	})
	expect(mocks.findActivePromotionCode).not.toHaveBeenCalled()
	expect(mocks.createCheckoutSession).not.toHaveBeenCalled()

	mocks.findActivePromotionCode.mockResolvedValueOnce({
		id: 'promo_agency_1',
		code: 'AGENCY-1',
		active: true,
		expires_at: Math.floor(Date.now() / 1000) + 86_400,
		max_redemptions: 1,
		times_redeemed: 0,
	})
	const monthly = await postCheckout(env, 'acme', {
		plan: 'pro',
		interval: 'month',
		promoCode: ' AGENCY-1 ',
	})
	expect(monthly.status).toBe(200)
	expect(mocks.findActivePromotionCode).toHaveBeenCalledWith(env, 'AGENCY-1')
	expect(mocks.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.objectContaining({
			priceId: 'price_pro',
			promotionCodeId: 'promo_agency_1',
			quantity: 2,
		}),
	)

	// An empty field is no code at all.
	await postCheckout(env, 'acme', {
		plan: 'pro',
		interval: 'year',
		promoCode: '  ',
	})
	expect(mocks.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.not.objectContaining({ promotionCodeId: expect.anything() }),
	)
})

test('unusable promo codes get a specific message and never reach Checkout', async () => {
	signInAs('ada')
	const env = createEnv()
	const nowSeconds = Math.floor(Date.now() / 1000)
	const cases: Array<[unknown, string]> = [
		[null, "That promo code isn't valid."],
		[
			{
				id: 'promo_old',
				code: 'OLD',
				active: true,
				expires_at: nowSeconds - 60,
				max_redemptions: 1,
				times_redeemed: 0,
			},
			'That promo code has expired.',
		],
		[
			{
				id: 'promo_used',
				code: 'USED',
				active: true,
				expires_at: null,
				max_redemptions: 1,
				times_redeemed: 1,
			},
			'That promo code has already been used.',
		],
	]
	for (const [promotion, error] of cases) {
		mocks.findActivePromotionCode.mockResolvedValueOnce(promotion)
		const response = await postCheckout(env, 'acme', {
			plan: 'pro',
			promoCode: 'CODE',
		})
		expect([response.status, await response.json()]).toEqual([
			400,
			{ ok: false, error },
		])
	}
	const malformed = await postCheckout(env, 'acme', {
		plan: 'pro',
		promoCode: 'not a code!',
	})
	expect(malformed.status).toBe(400)
	expect(mocks.createCheckoutSession).not.toHaveBeenCalled()

	// Stripe's own coupon rules (product restriction) still apply.
	mocks.findActivePromotionCode.mockResolvedValueOnce({
		id: 'promo_other_product',
		code: 'OTHER',
		active: true,
	})
	mocks.createCheckoutSession.mockRejectedValueOnce(
		new StripeApiError('Stripe API request failed with HTTP 400.', {
			status: 400,
		}),
	)
	consoleError.mockImplementation(() => {})
	try {
		const rejected = await postCheckout(env, 'acme', {
			plan: 'pro',
			promoCode: 'OTHER',
		})
		expect([rejected.status, await rejected.json()]).toEqual([
			400,
			{ ok: false, error: promoRejectedByStripe },
		])
	} finally {
		consoleError.mockReset()
	}

	// An existing subscription changes plans in the portal, where Kody cannot
	// attach a code.
	linkCustomer('org-acme', 'cus_acme')
	mocks.listSubscriptions.mockResolvedValueOnce([
		subscription({ id: 'sub_pro', status: 'active', priceId: 'price_pro' }),
	])
	const subscribed = await postCheckout(env, 'acme', {
		plan: 'pro',
		interval: 'month',
		promoCode: 'AGENCY-2',
	})
	expect([subscribed.status, await subscribed.json()]).toEqual([
		409,
		{ ok: false, error: existingSubscriptionPromoRejection },
	])
	expect(mocks.createBillingPortalSession).not.toHaveBeenCalled()
})

test('existing subscribers switch plans through the portal update flow', async () => {
	signInAs('ada')
	linkCustomer('person-ada', 'cus_existing')
	const env = createEnv({ STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_kody' })

	// Linked customer whose subscriptions are all canceled: plain Checkout.
	mocks.listSubscriptions.mockResolvedValueOnce([
		subscription({
			id: 'sub_old',
			status: 'canceled',
			priceId: retiredStandardPriceId,
		}),
	])
	const resubscribe = await postCheckout(env, 'ada', { plan: 'pro' })
	expect(await resubscribe.json()).toMatchObject({ mode: 'checkout' })
	expect(mocks.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.objectContaining({ customerId: 'cus_existing' }),
	)

	mocks.listSubscriptions.mockResolvedValueOnce([
		subscription({
			id: 'sub_standard',
			status: 'active',
			priceId: retiredStandardPriceId,
		}),
	])
	const upgrade = await postCheckout(env, 'ada', {
		plan: 'pro',
		interval: 'year',
	})
	expect(await upgrade.json()).toEqual({
		ok: true,
		url: 'https://billing.stripe.com/p/session/test',
		mode: 'portal_update',
	})
	expect(mocks.createBillingPortalSession).toHaveBeenLastCalledWith(env, {
		customerId: 'cus_existing',
		returnUrl: 'https://example.com/@ada/billing',
		configuration: 'bpc_kody',
		flowData: {
			type: 'subscription_update_confirm',
			subscriptionId: 'sub_standard',
			subscriptionItemId: 'si_sub_standard',
			priceId: 'price_pro_yearly',
			afterCompletionRedirectUrl:
				'https://example.com/@ada/billing?billing=updated',
			quantity: 1,
		},
	})

	mocks.listSubscriptions.mockResolvedValueOnce([
		subscription({ id: 'sub_pro', status: 'active', priceId: 'price_pro' }),
	])
	const samePlan = await postCheckout(env, 'ada', { plan: 'pro' })
	expect([samePlan.status, await samePlan.json()]).toEqual([
		409,
		{ ok: false, error: 'You are already on that plan.' },
	])

	// Legacy double Kody subscriptions: plain portal so the customer picks
	// which to keep. A shared-account product does not count.
	mocks.listSubscriptions.mockResolvedValueOnce([
		subscription({
			id: 'sub_standard',
			status: 'active',
			priceId: retiredStandardPriceId,
		}),
		subscription({ id: 'sub_pro', status: 'trialing', priceId: 'price_pro' }),
		subscription({
			id: 'sub_gratitext',
			status: 'active',
			priceId: 'price_gratitext_premium_15',
		}),
	])
	const doubled = await postCheckout(env, 'ada', { plan: 'pro' })
	expect(await doubled.json()).toMatchObject({ mode: 'portal' })

	consoleError.mockImplementation(() => {})
	try {
		mocks.listSubscriptions.mockRejectedValueOnce(
			new StripeApiError('Stripe API request failed with HTTP 503.', {
				status: 503,
			}),
		)
		const stripeDown = await postCheckout(env, 'ada', { plan: 'pro' })
		expect([stripeDown.status, await stripeDown.json()]).toEqual([
			502,
			{ ok: false, error: 'Unable to start checkout. Try again shortly.' },
		])
	} finally {
		consoleError.mockReset()
	}
})

test('billing data is readable by owners and billing admins of the org in the URL', async () => {
	const env = createEnv()
	const getBilling = (slug: string) =>
		call(createOrgBillingApiHandler, env, `/@${slug}/billing.json`)

	signInAs('cara')
	const billingAdmin = await getBilling('acme')
	expect(billingAdmin.status).toBe(200)
	expect(await billingAdmin.json()).toEqual({
		ok: true,
		org: {
			id: 'org-acme',
			slug: 'acme',
			displayName: 'Acme',
			personal: false,
		},
		canManage: true,
		seats: 2,
	})

	signInAs('ada')
	expect(await (await getBilling('ada')).json()).toMatchObject({
		org: { id: 'person-ada', slug: 'ada', personal: true },
		seats: 1,
	})

	signInAs('bob')
	expect((await getBilling('acme')).status).toBe(403)
	signInAs('dan')
	expect((await getBilling('acme')).status).toBe(404)
	signInAs(null)
	expect((await getBilling('acme')).status).toBe(401)
})

test('checkout return links the Stripe customer onto the org in the URL', async () => {
	mocks.linkStripeCustomerFromCheckoutSessionAttribution.mockResolvedValue({})
	const env = createEnv()
	const getSuccess = (path: string) =>
		call(createOrgBillingSuccessHandler, env, path)

	signInAs('ada')
	const missing = await getSuccess('/@acme/billing/success')
	expect(missing.status).toBe(302)
	expect(missing.headers.get('location')).toBe(
		'https://example.com/@acme/billing?error=missing_session',
	)

	const linked = await getSuccess('/@acme/billing/success?session_id=cs_test')
	expect(linked.status).toBe(200)
	expect(await linked.json()).toMatchObject({
		loaderData: { accountBillingSuccess: { ok: true, needsOnboarding: true } },
	})
	expect(
		mocks.linkStripeCustomerFromCheckoutSessionAttribution,
	).toHaveBeenCalledWith(
		expect.objectContaining({ sessionId: 'cs_test', orgId: 'org-acme' }),
	)

	signInAs('bob')
	const member = await getSuccess('/@acme/billing/success?session_id=cs_test')
	expect(member.status).toBe(403)
	expect(
		mocks.linkStripeCustomerFromCheckoutSessionAttribution,
	).toHaveBeenCalledTimes(1)
})

test('the Stripe portal opens for the org in the URL and only for managers', async () => {
	linkCustomer('org-acme', 'cus_acme')
	const env = createEnv()
	const getPortal = () =>
		call(createOrgBillingPortalHandler, env, '/@acme/billing/portal')

	signInAs('cara')
	const opened = await getPortal()
	expect(opened.status).toBe(302)
	expect(opened.headers.get('location')).toBe(
		'https://billing.stripe.com/p/session/test',
	)
	expect(mocks.createBillingPortalSession).toHaveBeenCalledWith(
		env,
		expect.objectContaining({
			customerId: 'cus_acme',
			returnUrl: 'https://example.com/@acme/billing',
		}),
	)

	signInAs('bob')
	expect((await getPortal()).status).toBe(403)
	signInAs('dan')
	expect((await getPortal()).status).toBe(404)
	expect(mocks.createBillingPortalSession).toHaveBeenCalledTimes(1)
})

test('/account/billing URLs open the signup organization billing page', async () => {
	const env = createEnv()
	signInAs('ada')
	const page = await call(
		createAccountBillingRedirectHandler,
		env,
		'/account/billing?error=portal_failed',
	)
	expect(page.status).toBe(302)
	expect(page.headers.get('location')).toBe(
		'https://example.com/@ada/billing?error=portal_failed',
	)

	const success = await call(
		(e) => createAccountBillingRedirectHandler(e, 'success'),
		env,
		'/account/billing/success?session_id=cs_old',
	)
	expect(success.headers.get('location')).toBe(
		'https://example.com/@ada/billing/success?session_id=cs_old',
	)
})

test('billing cancellation feedback records platform feedback', async () => {
	mocks.submitPlatformFeedback.mockResolvedValue({ id: 'fb_1' })
	mocks.enqueuePlatformFeedbackDispatch.mockResolvedValue(undefined)
	const env = createEnv()
	const post = (body: unknown) =>
		call(
			createAccountBillingCancellationFeedbackApiHandler,
			env,
			'/account/billing/cancellation-feedback.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			},
		)

	signInAs(null)
	expect((await post({ details: 'Too expensive.' })).status).toBe(401)

	signInAs('ada')
	expect((await post({ details: '   ' })).status).toBe(400)
	const success = await post({ details: 'Too expensive for my usage.' })
	expect([success.status, await success.json()]).toEqual([200, { ok: true }])
	expect(mocks.submitPlatformFeedback).toHaveBeenCalledWith(
		expect.objectContaining({
			submitterUserId: 'person-ada',
			submitterUsername: 'ada',
			category: 'cancellation',
			details: 'Too expensive for my usage.',
		}),
	)
	expect(mocks.enqueuePlatformFeedbackDispatch).toHaveBeenCalledWith(
		expect.objectContaining({ feedbackId: 'fb_1' }),
	)
})
