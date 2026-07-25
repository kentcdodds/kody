import { type Handle, css, on } from 'remix/ui'
import {
	type AccountBillingLoaderData,
	type AdminPlanName,
} from '#app/loader-data.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	MetadataGrid,
} from '#client/routes/account-management-components.tsx'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#client/styles/tokens.ts'
import {
	descriptionCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	layoutMaxWidths,
	primaryLinkCss,
} from '#client/styles/style-primitives.ts'

const billingApiPath = '/account/billing.json'
const billingCheckoutApiPath = '/account/billing/checkout.json'
const billingPath = '/account/billing'
const billingPortalPath = '/account/billing/portal'

type PaidTier = 'pro'
type PlanTier = 'free' | PaidTier
type SubscriptionStatusTone = 'ok' | 'warn' | 'action' | 'muted'

const planTiers: Array<{
	id: PlanTier
	name: string
	price: string
	description: string
}> = [
	{
		id: 'free',
		name: 'Free',
		price: '$0',
		description: 'Tight limits for trying Kody.',
	},
	{
		id: 'pro',
		name: 'Pro',
		price: '$5/month',
		description: 'Higher limits for heavier workflows and services.',
	},
]

/** Mirrors server rank: free < pro < partner < max. */
function getPlanRank(plan: AdminPlanName): number {
	switch (plan) {
		case 'free':
			return 0
		case 'pro':
			return 1
		case 'partner':
			return 2
		case 'max':
			return 3
		default: {
			const exhaustive: never = plan
			throw new Error(`Unknown plan: ${String(exhaustive)}`)
		}
	}
}

function isBillingPath(href: string) {
	return new URL(href, 'http://localhost').pathname === billingPath
}

/** Stripe missing → "None"; manual/effective compatibility missing → "Free". */
function formatPlanLabel(
	plan: AdminPlanName | null,
	missingLabel: 'None' | 'Free',
) {
	if (plan == null) return missingLabel
	return plan.charAt(0).toUpperCase() + plan.slice(1)
}

function formatCancelDate(value: string) {
	const date = new Date(
		value.includes('T') ? value : `${value.replace(' ', 'T')}Z`,
	)
	return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

function planCoversTier(effectivePlan: AdminPlanName, tier: PlanTier): boolean {
	return getPlanRank(effectivePlan) >= getPlanRank(tier)
}

function describeSubscriptionStatus(status: string): {
	label: string
	detail: string
	tone: SubscriptionStatusTone
} {
	switch (status) {
		case 'active':
			return {
				label: 'Active',
				detail: 'Your Stripe subscription is active.',
				tone: 'ok',
			}
		case 'trialing':
			return {
				label: 'Trialing',
				detail: 'You are on a Stripe trial.',
				tone: 'ok',
			}
		case 'past_due':
			return {
				label: 'Past due',
				detail:
					'Payment is past due, so paid plan limits are not active. Update your payment method in Manage subscription to restore Pro.',
				tone: 'action',
			}
		case 'unpaid':
			return {
				label: 'Unpaid',
				detail:
					'Stripe reports this subscription as unpaid, so paid plan limits are not active. Open Manage subscription to restore billing.',
				tone: 'action',
			}
		case 'canceled':
			return {
				label: 'Canceled',
				detail: 'This Stripe subscription is canceled.',
				tone: 'muted',
			}
		case 'incomplete':
			return {
				label: 'Incomplete',
				detail:
					'Checkout did not finish. Subscribe again or open Manage subscription if a customer already exists.',
				tone: 'warn',
			}
		case 'incomplete_expired':
			return {
				label: 'Incomplete (expired)',
				detail:
					'An incomplete checkout expired. Subscribe again to start billing.',
				tone: 'muted',
			}
		case 'paused':
			return {
				label: 'Paused',
				detail: 'This Stripe subscription is paused.',
				tone: 'warn',
			}
		default:
			return {
				label: status.replaceAll('_', ' '),
				detail: `Stripe subscription status: ${status}.`,
				tone: 'muted',
			}
	}
}

function subscriptionStatusBadgeCss(tone: SubscriptionStatusTone) {
	const accent =
		tone === 'action'
			? colors.error
			: tone === 'warn'
				? colors.primaryText
				: tone === 'ok'
					? colors.primary
					: colors.textMuted
	return {
		display: 'inline-flex',
		alignItems: 'center',
		padding: `0.2rem ${spacing.sm}`,
		borderRadius: radius.md,
		border: `1px solid ${accent}`,
		backgroundColor:
			tone === 'action'
				? 'color-mix(in srgb, var(--color-danger) 10%, var(--color-surface))'
				: colors.surface,
		color: accent,
		fontSize: typography.fontSize.xs,
		fontWeight: typography.fontWeight.semibold,
		textTransform: 'capitalize' as const,
	}
}

export async function accountBillingRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(billingApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountBillingLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load billing.')
	}
	return { accountBilling: payload }
}

export function AccountBillingRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let data: AccountBillingLoaderData | null = null
	let message: string | null = null
	let messageTone: 'error' | 'info' = 'info'
	let checkoutPending = false
	const loadLatch = createRouteLoadLatch()

	function applyPayload(payload: AccountBillingLoaderData) {
		data = payload
		status = 'ready'
		message = payload.error ?? null
		messageTone = payload.error ? 'error' : 'info'
	}

	async function startCheckout() {
		if (checkoutPending) return
		checkoutPending = true
		message = null
		handle.update()
		try {
			const response = await fetch(billingCheckoutApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({}),
			})
			const payload = await readJson<{
				ok?: boolean
				url?: string
				error?: string
			}>(response)
			if (response.ok && payload?.ok && typeof payload.url === 'string') {
				window.location.assign(payload.url)
				return
			}
			message =
				typeof payload?.error === 'string' && payload.error.length > 0
					? payload.error
					: 'Unable to start checkout. Try again shortly.'
			messageTone = 'error'
			checkoutPending = false
			handle.update()
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to start checkout. Try again shortly.'
			messageTone = 'error'
			checkoutPending = false
			handle.update()
		}
	}

	async function loadBilling(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		try {
			const response = await fetch(billingApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountBillingLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load billing.')
			}
			applyPayload(payload)
			loadLatch.markLoaded(href)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load billing.'
			messageTone = 'error'
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!isBillingPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'accountBilling', href)
		if (!routeData) return false
		applyPayload(routeData)
		loadLatch.markLoaded(href)
		return true
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadBilling)
		}

		const billing = status === 'ready' ? data : null
		const subscriptionStatus = billing?.subscriptionStatus?.trim() || null
		const statusInfo = subscriptionStatus
			? describeSubscriptionStatus(subscriptionStatus)
			: null
		const paymentActionNeeded =
			subscriptionStatus === 'past_due' || subscriptionStatus === 'unpaid'
		const showSubscribeCta = Boolean(
			billing?.checkoutAvailable &&
			billing &&
			!planCoversTier(billing.effectivePlan, 'pro') &&
			!paymentActionNeeded,
		)
		const showManageCta = Boolean(
			billing?.configured && billing.hasStripeCustomer,
		)
		const currentPlanItems =
			billing && billing.manualPlan !== billing.stripePlan
				? [
						{
							label: 'Granted plan',
							value: formatPlanLabel(billing.manualPlan, 'Free'),
						},
						{
							label: 'Subscription plan',
							value: formatPlanLabel(billing.stripePlan, 'None'),
						},
					]
				: []

		return (
			<AccountManagementShell maxWidth={layoutMaxWidths.content}>
				<AccountPageHeader
					title="Billing"
					description="View your plan, subscribe to Pro, and manage your Stripe subscription."
					currentHref={currentHref}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading billing…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}

				{billing ? (
					<>
						{!billing.configured ? (
							<AccountManagementMessage tone="info">
								Billing is not configured on this deployment. Plans can still be
								granted by an administrator.
							</AccountManagementMessage>
						) : null}
						{billing.configured && !billing.hasStripeCustomer ? (
							<AccountManagementMessage tone="info">
								No Stripe customer is linked yet. Subscribe to Pro to create one
								and manage billing in Stripe.
							</AccountManagementMessage>
						) : null}
						{billing.configured && billing.hasStripeCustomer ? (
							<p mix={css(descriptionCss)}>
								Stripe customer linked. Use Manage subscription for payment
								methods, invoices, and cancellation.
							</p>
						) : null}
						{statusInfo?.tone === 'action' ? (
							<AccountManagementMessage tone="error">
								{statusInfo.detail}
							</AccountManagementMessage>
						) : null}

						<AccountManagementPanel
							title="Current plan"
							description="Your effective plan is the higher of any admin grant and your Stripe subscription."
						>
							<div
								mix={css({
									display: 'flex',
									flexWrap: 'wrap',
									alignItems: 'center',
									gap: spacing.sm,
								})}
							>
								<p
									mix={css({
										margin: 0,
										fontSize: typography.fontSize.lg,
										fontWeight: typography.fontWeight.semibold,
										color: colors.text,
									})}
								>
									{formatPlanLabel(billing.effectivePlan, 'Free')}
								</p>
								{statusInfo ? (
									<span mix={css(subscriptionStatusBadgeCss(statusInfo.tone))}>
										{statusInfo.label}
									</span>
								) : null}
							</div>
							{statusInfo && statusInfo.tone !== 'action' ? (
								<p mix={css(descriptionCss)}>{statusInfo.detail}</p>
							) : null}
							{currentPlanItems.length > 0 ? (
								<MetadataGrid items={currentPlanItems} />
							) : null}
							{billing.cancelAt ? (
								<p mix={css(descriptionCss)}>
									Your subscription is scheduled to cancel on{' '}
									{formatCancelDate(billing.cancelAt)}.
								</p>
							) : null}
							<p mix={css(descriptionCss)}>
								Upgrades and payment changes apply after Stripe confirms them
								(usually within a few seconds via webhooks). Refresh this page
								if the plan looks stale.
							</p>
						</AccountManagementPanel>

						<AccountManagementPanel
							title="Actions"
							description="Subscribe, open the Stripe portal, or check entitlement use."
						>
							<div
								mix={css({
									display: 'flex',
									flexWrap: 'wrap',
									gap: spacing.sm,
									alignItems: 'center',
								})}
							>
								{showSubscribeCta ? (
									<button
										type="button"
										disabled={checkoutPending}
										mix={[
											on('click', () => void startCheckout()),
											css(primaryButtonCss),
										]}
									>
										{checkoutPending ? 'Starting checkout…' : 'Subscribe'}
									</button>
								) : null}
								{showManageCta ? (
									<a
										href={billingPortalPath}
										mix={css({
											...(statusInfo?.tone === 'action'
												? primaryButtonCss
												: secondaryButtonCss),
											display: 'inline-block',
											textDecoration: 'none',
											textAlign: 'center',
										})}
									>
										Manage subscription
									</a>
								) : null}
								<a
									href={billing.usageHref}
									mix={css({
										...secondaryButtonCss,
										display: 'inline-block',
										textDecoration: 'none',
										textAlign: 'center',
									})}
								>
									View usage
								</a>
							</div>
						</AccountManagementPanel>

						<AccountManagementPanel
							title="Plans"
							description="Choose a plan that fits how you use Kody."
						>
							<div
								mix={css({
									display: 'grid',
									gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
									gap: spacing.md,
									[mq.mobile]: {
										gridTemplateColumns: '1fr',
									},
								})}
							>
								{planTiers.map((tier) => {
									const isCurrent = billing.effectivePlan === tier.id
									const isIncluded =
										!isCurrent && planCoversTier(billing.effectivePlan, tier.id)
									const showSubscribe =
										tier.id !== 'free' &&
										!isCurrent &&
										!isIncluded &&
										billing.checkoutAvailable &&
										!paymentActionNeeded

									return (
										<div
											key={tier.id}
											mix={css({
												display: 'grid',
												gap: spacing.sm,
												alignContent: 'start',
												padding: spacing.md,
												borderRadius: radius.md,
												border: `1px solid ${colors.border}`,
												backgroundColor: colors.background,
											})}
										>
											<strong
												mix={css({
													fontSize: typography.fontSize.base,
													fontWeight: typography.fontWeight.semibold,
													color: colors.text,
												})}
											>
												{tier.name}
											</strong>
											<span
												mix={css({
													fontSize: typography.fontSize.lg,
													fontWeight: typography.fontWeight.semibold,
													color: colors.text,
												})}
											>
												{tier.price}
											</span>
											<p mix={css(descriptionCss)}>{tier.description}</p>
											{isCurrent || isIncluded ? (
												<div>
													<button
														type="button"
														disabled
														mix={css(secondaryButtonCss)}
													>
														{isCurrent
															? 'Current plan'
															: 'Included in your plan'}
													</button>
												</div>
											) : showSubscribe ? (
												<div>
													<button
														type="button"
														disabled={checkoutPending}
														mix={[
															on('click', () => void startCheckout()),
															css(primaryButtonCss),
														]}
													>
														{checkoutPending
															? 'Starting checkout…'
															: 'Subscribe'}
													</button>
												</div>
											) : null}
										</div>
									)
								})}
							</div>
						</AccountManagementPanel>
					</>
				) : null}

				<p mix={css({ margin: 0 })}>
					<a href="/account" mix={css(primaryLinkCss)}>
						Back to account
					</a>
				</p>
			</AccountManagementShell>
		)
	}
}

const primaryButtonCss = getPrimaryButtonCss()
const secondaryButtonCss = getSecondaryButtonCss()
