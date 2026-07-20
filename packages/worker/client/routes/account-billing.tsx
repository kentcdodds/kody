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
const billingPath = '/account/billing'

type PaidTier = 'pro'
type PlanTier = 'free' | PaidTier

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

/** Mirrors server rank: free < pro < partner. */
function getPlanRank(plan: AdminPlanName): number {
	switch (plan) {
		case 'free':
			return 0
		case 'pro':
			return 1
		case 'partner':
			return 2
		default: {
			const exhaustive: never = plan
			throw new Error(`Unknown plan: ${String(exhaustive)}`)
		}
	}
}

function isBillingPath(href: string) {
	return new URL(href, 'http://localhost').pathname === billingPath
}

function formatPlanLabel(plan: AdminPlanName | null) {
	if (plan == null) return 'Legacy / unlimited'
	return plan.charAt(0).toUpperCase() + plan.slice(1)
}

function formatCancelDate(value: string) {
	const date = new Date(
		value.includes('T') ? value : `${value.replace(' ', 'T')}Z`,
	)
	return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

function planCoversTier(
	effectivePlan: AdminPlanName | null,
	tier: PlanTier,
): boolean {
	if (effectivePlan == null) return true
	return getPlanRank(effectivePlan) >= getPlanRank(tier)
}

function getPaymentLink(data: AccountBillingLoaderData): string | undefined {
	return data.paymentLinks.pro
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
	const loadLatch = createRouteLoadLatch()

	function applyPayload(payload: AccountBillingLoaderData) {
		data = payload
		status = 'ready'
		message = payload.error ?? null
		messageTone = payload.error ? 'error' : 'info'
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
		const currentPlanItems =
			billing && billing.manualPlan !== billing.stripePlan
				? [
						{
							label: 'Granted plan',
							value: formatPlanLabel(billing.manualPlan),
						},
						{
							label: 'Subscription plan',
							value: formatPlanLabel(billing.stripePlan),
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

						<AccountManagementPanel
							title="Current plan"
							description="Your effective plan is the higher of any admin grant and your Stripe subscription."
						>
							<p
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								})}
							>
								{formatPlanLabel(billing.effectivePlan)}
							</p>
							{currentPlanItems.length > 0 ? (
								<MetadataGrid items={currentPlanItems} />
							) : null}
							{billing.cancelAt ? (
								<p mix={css(descriptionCss)}>
									Your subscription is scheduled to cancel on{' '}
									{formatCancelDate(billing.cancelAt)}.
								</p>
							) : null}
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
									const paymentLink =
										tier.id === 'free' ? undefined : getPaymentLink(billing)
									const showSubscribe =
										!isCurrent &&
										!isIncluded &&
										billing.configured &&
										typeof paymentLink === 'string' &&
										paymentLink.length > 0

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
													<a
														href={paymentLink}
														mix={css({
															...primaryButtonCss,
															display: 'inline-block',
															textDecoration: 'none',
															textAlign: 'center',
														})}
													>
														Subscribe
													</a>
												</div>
											) : null}
										</div>
									)
								})}
							</div>
						</AccountManagementPanel>

						{billing.hasStripeCustomer && billing.configured ? (
							<AccountManagementPanel
								title="Manage subscription"
								description="Open the Stripe billing portal to cancel, upgrade, update payment methods, or download invoices."
							>
								<div>
									{/* Server-only redirect route: bypass the SPA router with a
									    full-page navigation, matching the app's established
									    window.location.assign pattern. */}
									<a
										href="/account/billing/portal"
										mix={[
											on('click', (event) => {
												event.preventDefault()
												window.location.assign('/account/billing/portal')
											}),
											css({
												...secondaryButtonCss,
												display: 'inline-block',
												textDecoration: 'none',
												textAlign: 'center',
											}),
										]}
									>
										Manage subscription
									</a>
								</div>
							</AccountManagementPanel>
						) : null}
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
