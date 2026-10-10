import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	loadAccountBillingData,
	type BillingPageOrg,
} from '#app/account-billing-data.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	readAuthenticatedAppUser,
	type AuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { userHasMcpOAuthGrants } from '#app/onboarding-data.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	authorize,
	AuthorizationError,
} from '#worker/authorization/authorize.ts'
import { orgBillingPath } from '#universal/org-pages.ts'
import { type routes } from '#universal/routes.ts'
import {
	createBillingPortalSession,
	createCheckoutSession,
	listSubscriptions,
	BillingNotConfiguredError,
	StripeApiError,
} from '#worker/billing/stripe-client.ts'
import {
	createBillingLinkReference,
	getBillingPortalConfigurationId,
	getPriceIdForPlan,
	isBillingConfigured,
	parseBillingInterval,
	selectKodyPlanRetainingSubscriptions,
	subscriptionHasPrice,
} from '#worker/billing/billing-config.ts'
import {
	existingSubscriptionPromoRejection,
	parsePromoCodeInput,
	promoIntervalRejection,
	promoRejectedByStripe,
	resolveCheckoutPromotionCode,
} from '#worker/billing/checkout-promo.ts'
import {
	BillingLinkError,
	linkStripeCustomerFromCheckoutSessionAttribution,
} from '#worker/billing/subscription-sync.ts'
import { enqueuePlatformFeedbackDispatch } from '#worker/platform-feedback/dispatch-queue-producer.ts'
import { isPlatformFeedbackDomainError } from '#worker/platform-feedback/errors.ts'
import { submitPlatformFeedback } from '#worker/platform-feedback/service.ts'
import { recordCheckoutFunnelEvent } from '#worker/identity/onboarding-funnel.ts'
import { buildOrgBillingMetadata } from '#worker/billing/org-stripe-metadata.ts'
import {
	countLiveSeats,
	readOrgStripeCustomerId,
} from '#worker/orgs/billing.ts'
import { getOrgById } from '#worker/orgs/repo.ts'

type OrgBillingAccess =
	| { ok: true; org: BillingPageOrg }
	| { ok: false; status: 403 | 404; error: string }

/**
 * The organization a `/@slug/-/billing...` request acts on, when the person may
 * use `permission` there. The request context binds that organization
 * (org-request-binding.ts), so `authorize` is the same check MCP billing
 * capabilities run. A slug the person cannot reach is a 404, never a silent
 * fall back to their signup organization.
 */
async function resolveOrgBillingAccess(input: {
	request: Request
	env: Env
	user: AuthenticatedAppUser
	permission: Extract<OrgPermission, 'billing:read' | 'billing:write'>
}): Promise<OrgBillingAccess> {
	const resolution = await loadRequestOrgResolution(
		input.request,
		input.env,
		input.user.mcpUser.userId,
	)
	if (typeof resolution === 'string') {
		return { ok: false, status: 404, error: 'Organization unavailable.' }
	}
	const slug = resolution.org.slug ?? input.user.username
	try {
		await authorize(
			{ env: input.env, request: input.user.request },
			input.permission,
		)
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		return {
			ok: false,
			status: 403,
			error: `Only owners and billing admins can manage billing for @${slug}.`,
		}
	}
	const record = await getOrgById(input.env.APP_DB, resolution.org.id)
	if (!record) {
		throw new Error(`Cannot load billing: missing org ${resolution.org.id}.`)
	}
	return {
		ok: true,
		org: {
			id: resolution.org.id,
			slug: record.slug,
			displayName: record.display_name,
			personal: resolution.org.id === personalOrgId(input.user.mcpUser.userId),
		},
	}
}

function orgBillingUrl(request: Request, slug: string, step = '') {
	return new URL(
		step ? `${orgBillingPath(slug)}/${step}` : orgBillingPath(slug),
		request.url,
	)
}

function billingErrorRedirect(
	request: Request,
	slug: string,
	errorCode: string,
) {
	const url = orgBillingUrl(request, slug)
	url.searchParams.set('error', errorCode)
	return Response.redirect(url.toString(), 302)
}

/**
 * Page data for someone who already passed `billing:read`. That permission
 * implies `billing:write`: the billing role preset includes both, and
 * billing permissions cannot be granted. The page has no read-only state.
 */
async function loadOrgBillingPageData(input: {
	request: Request
	env: Env
	user: AuthenticatedAppUser
	org: BillingPageOrg
}) {
	const searchParams = new URL(input.request.url).searchParams
	return await loadAccountBillingData({
		env: input.env,
		userId: input.user.userId,
		org: input.org,
		seats: Math.max(1, await countLiveSeats(input.env.APP_DB, input.org.id)),
		errorCode: searchParams.get('error'),
		noticeCode: searchParams.get('billing'),
	})
}

function renderBillingDenied(
	request: Request,
	env: Env,
	access: Extract<OrgBillingAccess, { ok: false }>,
) {
	return renderAppPage({
		request,
		env,
		title: access.status === 404 ? 'Organization unavailable' : 'Billing',
		...(access.status === 404 ? { notFound: true } : { unauthorized: true }),
		status: access.status,
	})
}

/**
 * `/account/billing` and its pre-move Checkout return URL open the signup
 * organization's billing page, keeping the query (`session_id`, `error`).
 */
export function createAccountBillingRedirectHandler(env: Env, step = '') {
	return {
		middleware: [],
		async handler({ request }: { request: Request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) return user
			const requestUrl = new URL(request.url)
			// `/account/*` binds the signup organization, whose slug survives
			// username changes.
			const destination = orgBillingUrl(
				request,
				user.request.org.slug || user.username,
				step,
			)
			destination.search = requestUrl.search
			return Response.redirect(destination.toString(), 302)
		},
	}
}

export function createOrgBillingHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}
			const access = await resolveOrgBillingAccess({
				request,
				env,
				user,
				permission: 'billing:read',
			})
			if (!access.ok) return renderBillingDenied(request, env, access)
			const accountBilling = await loadOrgBillingPageData({
				request,
				env,
				user,
				org: access.org,
			})
			return renderAppPage({
				request,
				env,
				title: 'Billing',
				loaderData: { accountBilling },
			})
		},
	} satisfies Action<typeof routes.orgBilling>
}

export function createOrgBillingApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const access = await resolveOrgBillingAccess({
				request,
				env,
				user,
				permission: 'billing:read',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}
			return jsonResponse(
				await loadOrgBillingPageData({ request, env, user, org: access.org }),
			)
		},
	} satisfies Action<typeof routes.orgBillingApi>
}

export function createOrgBillingCheckoutApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const access = await resolveOrgBillingAccess({
				request,
				env,
				user,
				permission: 'billing:write',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}

			const body = (await request.json().catch(() => null)) as {
				plan?: unknown
				interval?: unknown
				promoCode?: unknown
			} | null
			const plan = body?.plan === 'pro' ? body.plan : null
			if (!plan) {
				return jsonResponse({ ok: false, error: 'Choose Pro.' }, 400)
			}
			const interval = parseBillingInterval(body?.interval)
			if (!interval) {
				return jsonResponse(
					{ ok: false, error: 'Choose monthly or annual billing.' },
					400,
				)
			}
			const promo = parsePromoCodeInput(body?.promoCode)
			if (!promo.ok) {
				return jsonResponse({ ok: false, error: promo.error }, 400)
			}
			if (promo.code) {
				const intervalRejection = promoIntervalRejection(interval)
				if (intervalRejection) {
					return jsonResponse({ ok: false, error: intervalRejection }, 400)
				}
			}
			const priceId = getPriceIdForPlan(env, plan, interval)
			if (!isBillingConfigured(env) || !priceId) {
				return jsonResponse(
					{
						ok: false,
						error: 'Pro checkout is not configured on this deployment.',
					},
					409,
				)
			}

			const { org } = access
			const customerId =
				(await readOrgStripeCustomerId(env.APP_DB, org.id)) || undefined
			const seatQuantity = Math.max(1, await countLiveSeats(env.APP_DB, org.id))
			const billingUrl = orgBillingUrl(request, org.slug).toString()
			const requestIp = getRequestIp(request) ?? undefined
			const requestPath = new URL(request.url).pathname

			try {
				if (customerId) {
					// An existing subscriber must change plans on their current
					// subscription. A second Checkout Session would create a second
					// subscription that bills alongside the first (the plan resolver
					// grants the higher tier across all of them), so route switches
					// to Pro through the portal's prorated confirm flow, pinned to
					// the Pro price so a retired price is never offered.
					// Only Kody subscriptions. Never portal-update a shared-account
					// product (for example GratiText Premium) onto a Kody price.
					const planRetaining = selectKodyPlanRetainingSubscriptions(
						env,
						await listSubscriptions(env, customerId),
					)
					if (planRetaining.length > 0 && promo.code) {
						return jsonResponse(
							{ ok: false, error: existingSubscriptionPromoRejection },
							409,
						)
					}
					if (planRetaining.length === 1) {
						const subscription = planRetaining[0]!
						if (subscriptionHasPrice(subscription, priceId)) {
							return jsonResponse(
								{ ok: false, error: 'You are already on that plan.' },
								409,
							)
						}
						const subscriptionItemId = subscription.items.data.find(
							(item) => item.id,
						)?.id
						if (!subscriptionItemId) {
							const portal = await createBillingPortalSession(env, {
								customerId,
								returnUrl: billingUrl,
								configuration: getBillingPortalConfigurationId(env),
							})
							return jsonResponse({ ok: true, url: portal.url, mode: 'portal' })
						}
						const updatedUrl = new URL(billingUrl)
						updatedUrl.searchParams.set('billing', 'updated')
						const portal = await createBillingPortalSession(env, {
							customerId,
							returnUrl: billingUrl,
							configuration: getBillingPortalConfigurationId(env),
							flowData: {
								type: 'subscription_update_confirm',
								subscriptionId: subscription.id,
								subscriptionItemId,
								priceId,
								afterCompletionRedirectUrl: updatedUrl.toString(),
								quantity: seatQuantity,
							},
						})
						void logAuditEvent({
							db: auditDatabaseFromEnv(env),
							category: 'account',
							action: 'billing_plan_change_started',
							result: 'success',
							email: user.email,
							ip: requestIp,
							path: requestPath,
						})
						return jsonResponse({
							ok: true,
							url: portal.url,
							mode: 'portal_update',
						})
					}
					if (planRetaining.length > 1) {
						// Legacy double subscriptions: the portal update flow targets
						// one subscription, so let the customer sort out which to keep.
						const portal = await createBillingPortalSession(env, {
							customerId,
							returnUrl: billingUrl,
							configuration: getBillingPortalConfigurationId(env),
						})
						return jsonResponse({
							ok: true,
							url: portal.url,
							mode: 'portal',
						})
					}
				}

				let promotionCodeId: string | undefined
				if (promo.code) {
					const resolved = await resolveCheckoutPromotionCode(env, {
						code: promo.code,
						now: new Date(),
					})
					if (!resolved.ok) {
						return jsonResponse({ ok: false, error: resolved.error }, 400)
					}
					promotionCodeId = resolved.id
				}

				// Org is the billing subject; the signed-in member only authorizes.
				const clientReferenceId = await createBillingLinkReference(env, org.id)
				const successUrl = `${orgBillingUrl(request, org.slug, 'success').toString()}?session_id={CHECKOUT_SESSION_ID}`
				let session: { id: string; url: string }
				try {
					session = await createCheckoutSession(env, {
						priceId,
						clientReferenceId,
						successUrl,
						cancelUrl: billingUrl,
						quantity: seatQuantity,
						...(customerId ? { customerId } : { customerEmail: user.email }),
						...(promotionCodeId ? { promotionCodeId } : {}),
						// Org identity on Stripe objects (ADR 0065). HMAC client_reference_id
						// is also org-backed and verified on link.
						metadata: {
							...buildOrgBillingMetadata(org.id),
							kody_plan: plan,
						},
					})
				} catch (error) {
					// The code passed Kody's checks, so a 400 here is Stripe's own
					// coupon rule (product restriction, first-time-only).
					if (
						promotionCodeId &&
						error instanceof StripeApiError &&
						error.status === 400
					) {
						console.error('billing_checkout_promo_rejected', {
							orgId: org.id,
							code: error.code,
						})
						return jsonResponse(
							{ ok: false, error: promoRejectedByStripe },
							400,
						)
					}
					throw error
				}
				recordCheckoutFunnelEvent(env, {
					stage: 'checkout_started',
					userId: org.id,
					plan,
				})
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'billing_checkout_started',
					result: 'success',
					email: user.email,
					ip: requestIp,
					path: requestPath,
				})
				return jsonResponse({ ok: true, url: session.url, mode: 'checkout' })
			} catch (error) {
				if (error instanceof StripeApiError) {
					console.error('billing_checkout_failed', {
						stableUserId: user.mcpUser.userId,
						error: error.message,
					})
					return jsonResponse(
						{
							ok: false,
							error: 'Unable to start checkout. Try again shortly.',
						},
						502,
					)
				}
				throw error
			}
		},
	} satisfies Action<typeof routes.orgBillingCheckoutPost>
}

export function createAccountBillingCancellationFeedbackApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = (await request.json().catch(() => null)) as {
				details?: unknown
			} | null
			const details =
				typeof body?.details === 'string' ? body.details.trim() : ''
			if (!details) {
				return jsonResponse(
					{ ok: false, error: 'Share a sentence or two before sending.' },
					400,
				)
			}
			if (details.length > 8000) {
				return jsonResponse(
					{ ok: false, error: 'Feedback is limited to 8000 characters.' },
					400,
				)
			}

			const submitterUsername = user.username.trim()
			if (!submitterUsername) {
				return jsonResponse(
					{ ok: false, error: 'Unable to submit feedback for this account.' },
					409,
				)
			}

			try {
				const feedback = await submitPlatformFeedback({
					db: env.APP_DB,
					submitterUserId: user.mcpUser.userId,
					submitterUsername,
					submitterEmail: user.email,
					category: 'cancellation',
					summary: 'Subscription cancellation feedback',
					details,
				})
				try {
					await enqueuePlatformFeedbackDispatch({
						queue: env.PLATFORM_FEEDBACK_DISPATCH_QUEUE,
						feedbackId: feedback.id,
					})
				} catch (error) {
					console.error('platform-feedback-dispatch-enqueue-failed', error)
				}
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'billing_cancellation_feedback',
					result: 'success',
					email: user.email,
					ip: getRequestIp(request) ?? undefined,
					path: new URL(request.url).pathname,
				})
				return jsonResponse({ ok: true })
			} catch (error) {
				if (isPlatformFeedbackDomainError(error)) {
					return jsonResponse({ ok: false, error: error.message }, 429)
				}
				throw error
			}
		},
	} satisfies Action<typeof routes.accountBillingCancellationFeedbackPost>
}

export function createOrgBillingSuccessHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}
			const access = await resolveOrgBillingAccess({
				request,
				env,
				user,
				permission: 'billing:write',
			})
			if (!access.ok) return renderBillingDenied(request, env, access)
			const { org } = access

			if (!isBillingConfigured(env)) {
				return billingErrorRedirect(request, org.slug, 'billing_not_configured')
			}

			const sessionId =
				new URL(request.url).searchParams.get('session_id')?.trim() ?? ''
			if (!sessionId) {
				return billingErrorRedirect(request, org.slug, 'missing_session')
			}

			const requestIp = getRequestIp(request) ?? undefined
			try {
				// Link the Stripe customer onto the request-bound org. The member
				// is the authorizing actor only (audit email below).
				await linkStripeCustomerFromCheckoutSessionAttribution({
					env,
					sessionId,
					orgId: org.id,
				})
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'billing_checkout_linked',
					result: 'success',
					email: user.email,
					ip: requestIp,
					path: new URL(request.url).pathname,
				})
				const hasMcpClient = await userHasMcpOAuthGrants(
					env,
					user.mcpUser.userId,
				)
				const needsOnboarding = !user.emailVerified || !hasMcpClient
				return renderAppPage({
					request,
					env,
					title: "You're in",
					loaderData: {
						accountBillingSuccess: {
							ok: true,
							needsOnboarding,
						},
					},
				})
			} catch (error) {
				const code =
					error instanceof BillingLinkError ? error.code : 'link_failed'
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'billing_checkout_linked',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: new URL(request.url).pathname,
					reason: code,
				})
				return billingErrorRedirect(request, org.slug, code)
			}
		},
	} satisfies Action<typeof routes.orgBillingSuccess>
}

export function createOrgBillingPortalHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}
			const access = await resolveOrgBillingAccess({
				request,
				env,
				user,
				permission: 'billing:write',
			})
			if (!access.ok) return renderBillingDenied(request, env, access)
			const { org } = access

			if (!isBillingConfigured(env)) {
				return billingErrorRedirect(request, org.slug, 'billing_not_configured')
			}

			const customerId = await readOrgStripeCustomerId(env.APP_DB, org.id)
			if (!customerId) {
				return billingErrorRedirect(request, org.slug, 'no_customer')
			}

			try {
				const portal = await createBillingPortalSession(env, {
					customerId,
					returnUrl: orgBillingUrl(request, org.slug).toString(),
					configuration: getBillingPortalConfigurationId(env),
				})
				// Trust assumption: portal.url comes from the Stripe API host,
				// which is operator-controlled deployment config
				// (STRIPE_API_BASE_URL, default api.stripe.com) — not
				// user-influenced — so redirecting to it is not an open
				// redirect.
				return Response.redirect(portal.url, 302)
			} catch (error) {
				if (error instanceof BillingNotConfiguredError) {
					return billingErrorRedirect(
						request,
						org.slug,
						'billing_not_configured',
					)
				}
				console.error('billing_portal_failed', {
					stableUserId: user.mcpUser.userId,
					error: error instanceof Error ? error.message : String(error),
				})
				return billingErrorRedirect(request, org.slug, 'portal_failed')
			}
		},
	} satisfies Action<typeof routes.orgBillingPortal>
}
