import { type Handle, css, on } from 'remix/ui'
import { adminGrantDiffersFromSubscription } from '#app/account-plan-display.ts'
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
	getGhostButtonCss,
	getPillButtonCss,
	layoutMaxWidths,
	mutedLinkCss,
	primaryLinkCss,
} from '#client/styles/style-primitives.ts'

const billingApiPath = '/account/billing.json'
const billingCheckoutApiPath = '/account/billing/checkout.json'
const billingPath = '/account/billing'
const billingPortalPath = '/account/billing/portal'

type PaidTier = 'standard' | 'pro'
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
		description:
			'Room to build real automations. Capped on daily volume, not on how much you build.',
	},
	{
		id: 'standard',
		name: 'Standard',
		price: '$5/month',
		description: 'Higher daily volume, more services, and persistent ones.',
	},
	{
		id: 'pro',
		name: 'Pro',
		price: '$20/month',
		description:
			'For heavy daily automation — roughly double Standard on every axis.',
	},
]

/** Mirrors server rank: free < standard < pro < max. */
function getPlanRank(plan: AdminPlanName): number {
	switch (plan) {
		case 'free':
			return 0
		case 'standard':
			return 1
		case 'pro':
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
					'Payment is past due, so paid plan limits are not active. Update your payment method in Manage subscription to restore your paid plan.',
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
	let checkoutPendingPlan: PaidTier | null = null
	const loadLatch = createRouteLoadLatch()

	function applyPayload(payload: AccountBillingLoaderData) {
		data = payload
		status = 'ready'
		message = payload.error ?? null
		messageTone = payload.error ? 'error' : 'info'
	}

	async function startCheckout(plan: PlanTier) {
		if (plan === 'free') return
		if (checkoutPendingPlan) return
		checkoutPendingPlan = plan
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
				body: JSON.stringify({ plan }),
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
			checkoutPendingPlan = null
			handle.update()
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to start checkout. Try again shortly.'
			messageTone = 'error'
			checkoutPendingPlan = null
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
		const showManageCta = Boolean(
			billing?.configured && billing.hasStripeCustomer,
		)
		const planSourcesDiffer =
			billing != null &&
			adminGrantDiffersFromSubscription(billing.manualPlan, billing.stripePlan)
		const currentPlanItems = planSourcesDiffer
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
					description="View your plan, subscribe to Standard or Pro, and manage your Stripe subscription."
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
								{billing.purchasablePlans.length > 0
									? 'No Stripe customer is linked yet. Subscribe to a paid plan to create one and manage billing in Stripe.'
									: 'No paid tier is configured for checkout on this deployment.'}
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

						<AccountManagementPanel title="Current plan">
							<div
								mix={css({
									display: 'flex',
									flexWrap: 'wrap',
									alignItems: 'baseline',
									gap: `${spacing.sm} ${spacing.md}`,
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
								<a href={billing.usageHref} mix={css(mutedLinkCss)}>
									view usage
								</a>
							</div>
							{statusInfo && statusInfo.tone !== 'action' ? (
								<p mix={css(descriptionCss)}>{statusInfo.detail}</p>
							) : null}
							{currentPlanItems.length > 0 ? (
								<>
									<p mix={css(descriptionCss)}>
										Your effective plan is the higher of any admin grant and
										your Stripe subscription.
									</p>
									<MetadataGrid items={currentPlanItems} />
								</>
							) : null}
							{billing.cancelAt ? (
								<p mix={css(descriptionCss)}>
									Your subscription is scheduled to cancel on{' '}
									{formatCancelDate(billing.cancelAt)}.
								</p>
							) : null}
						</AccountManagementPanel>

						{showManageCta ? (
							<AccountManagementPanel
								title="Actions"
								description="Open the Stripe portal for payment methods, invoices, and cancellation."
							>
								<div
									mix={css({
										display: 'flex',
										flexWrap: 'wrap',
										gap: spacing.sm,
										alignItems: 'center',
									})}
								>
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
								</div>
							</AccountManagementPanel>
						) : null}

						<AccountManagementPanel
							title="Plans"
							description="Choose a plan that fits how you use Kody."
						>
							<div
								mix={css({
									display: 'grid',
									gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
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
										billing.purchasablePlans.includes(tier.id) &&
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
											<p mix={css({ margin: 0 })}>
												<a href="/account/usage" mix={css(primaryLinkCss)}>
													See your current usage
												</a>
											</p>
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
														disabled={checkoutPendingPlan !== null}
														mix={[
															on('click', () => void startCheckout(tier.id)),
															css(primaryButtonCss),
														]}
													>
														{checkoutPendingPlan === tier.id
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

const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
