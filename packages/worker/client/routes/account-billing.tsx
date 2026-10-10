import { type Handle, css, on } from 'remix/component'
import { adminGrantDiffersFromSubscription } from '#universal/account-plan-display.ts'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import {
	type AccountBillingLoaderData,
	type AdminPlanName,
} from '#universal/loader-data.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	accountFieldCss,
	accountFieldLabelCss,
	accountInputCss,
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	MetadataGrid,
} from '#client/routes/account-management-components.tsx'
import {
	type BillingInterval,
	type CheckoutPending,
	type PaidTier,
	isRetiredPaidSubscription,
	renderAccountBillingPlans,
	resolveActiveStripePlan,
} from '#client/routes/account-billing-plans.tsx'
import { requestProCheckout } from '#client/routes/billing-checkout.ts'
import { orgIdentity, parseOrgBillingPath } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	billingPortalPath,
	navigateBillingPortalOnPrimaryClick,
} from './billing-portal-navigation.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getGhostButtonCss,
	getPillButtonCss,
	layoutMaxWidths,
	mutedLinkCss,
	primaryLinkCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'

const jsonRequestHeaders = {
	Accept: 'application/json',
	'Content-Type': 'application/json',
}
const billingCancellationFeedbackApiPath =
	'/account/billing/cancellation-feedback.json'

type SubscriptionStatusTone = 'ok' | 'warn' | 'action' | 'muted'

const multipleSubscriptionsMessage =
	'You have more than one active Stripe subscription, so plan changes are handled in the Stripe portal. Opening Stripe…'

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
					'Payment is past due. Your paid plan limits stay in place while Stripe retries the charge, but update your payment method in Manage subscription so the subscription does not end.',
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

function billingSlugFromHref(href: string) {
	return (
		parseOrgBillingPath(new URL(href, 'http://localhost').pathname)?.slug ??
		null
	)
}

function billingOrgSlug(href: string) {
	const slug = billingSlugFromHref(href)
	if (!slug) throw new Error(`Not an organization billing URL: ${href}`)
	return slug
}

/**
 * `?error=` and `?billing=` carry Stripe redirect outcomes; forwarding them
 * lets the JSON API map them to the same messages the SSR page renders.
 */
async function fetchOrgBilling(href: string, signal: AbortSignal) {
	const url = new URL(href, 'http://localhost')
	const response = await fetch(
		`${routes.orgBillingApi.href({ orgSlug: billingOrgSlug(href) })}${url.search}`,
		{
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		},
	)
	if (response.status === 401) return 'unauthorized' as const
	const payload = await readJson<
		AccountBillingLoaderData | { ok: false; error?: string }
	>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error(
			(payload && 'error' in payload && payload.error) ||
				'Unable to load billing.',
		)
	}
	return payload
}

export async function accountBillingRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const payload = await fetchOrgBilling(url.href, signal)
	if (payload === 'unauthorized') return routeLoaderRedirect('/login')
	return { accountBilling: payload }
}

export function AccountBillingRoute(handle: Handle) {
	let message: string | null = null
	let messageTone: 'error' | 'info' = 'info'
	let checkoutPending: CheckoutPending = null
	let cancellationFeedbackText = ''
	let cancellationFeedbackPending = false
	let cancellationFeedbackSent = false
	let cancellationFeedbackError: string | null = null
	let promoCode = ''
	/** Shown under the plan card's Subscribe button, where the customer is looking. */
	let planCheckoutError: string | null = null
	const selectedIntervalByPlan: Record<PaidTier, BillingInterval> = {
		pro: 'month',
	}
	/** Payload last applied to the closure state above. */
	let appliedPayload: AccountBillingLoaderData | null = null
	let appliedError: Error | null = null
	const billingData = createRouteData({
		key: 'accountBilling',
		async load(href, signal) {
			const payload = await fetchOrgBilling(href, signal)
			if (payload === 'unauthorized') return routeDataRedirect('/login')
			return payload
		},
	})

	function applyPayload(payload: AccountBillingLoaderData) {
		message = payload.error ?? payload.notice ?? null
		messageTone = payload.error ? 'error' : 'info'
	}

	async function startCheckout(
		orgSlug: string,
		plan: PaidTier,
		interval: BillingInterval,
		promo: string,
		errorPlacement: 'page' | 'plan-card',
	) {
		if (checkoutPending) return
		checkoutPending = { plan, interval }
		message = null
		planCheckoutError = null
		handle.update()
		const result = await requestProCheckout({
			orgSlug,
			interval,
			promoCode: promo,
		})
		if (result.ok) {
			if (result.mode === 'portal') {
				// More than one active subscription: the portal update flow
				// cannot pick one, so the customer manages them in Stripe.
				message = multipleSubscriptionsMessage
				messageTone = 'info'
				handle.update()
			}
			window.location.assign(result.url)
			return
		}
		if (errorPlacement === 'plan-card') {
			planCheckoutError = result.error
		} else {
			message = result.error
			messageTone = 'error'
		}
		checkoutPending = null
		handle.update()
	}

	async function submitCancellationFeedback() {
		const sendFallback = 'Unable to send feedback. Try again shortly.'
		if (cancellationFeedbackPending) return
		const details = cancellationFeedbackText.trim()
		if (!details) {
			cancellationFeedbackError = 'Share a sentence or two before sending.'
			handle.update()
			return
		}
		cancellationFeedbackPending = true
		cancellationFeedbackError = null
		handle.update()
		try {
			const response = await fetch(billingCancellationFeedbackApiPath, {
				method: 'POST',
				headers: jsonRequestHeaders,
				credentials: 'include',
				body: JSON.stringify({ details }),
			})
			const payload = await readJson<{ ok?: boolean; error?: string }>(response)
			if (response.ok && payload?.ok) {
				cancellationFeedbackSent = true
			} else {
				cancellationFeedbackError = payload?.error || sendFallback
			}
		} catch (error) {
			cancellationFeedbackError =
				error instanceof Error ? error.message : sendFallback
		}
		cancellationFeedbackPending = false
		handle.update()
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		// The router can keep this route mounted while a destination lazy
		// module is still loading. The href is already the next page then.
		const orgSlug = billingSlugFromHref(currentHref)
		if (!orgSlug) return null
		const snapshot = billingData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedPayload) {
			appliedPayload = snapshot.data
			applyPayload(snapshot.data)
		}
		if (snapshot.error && snapshot.error !== appliedError) {
			appliedError = snapshot.error
			message = snapshot.error.message
			messageTone = 'error'
		}
		const pending = snapshot.kind === 'pending'
		const status: AccountStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && appliedPayload === null
					? 'loading'
					: 'ready'

		const billing = snapshot.data
		// Only team organizations show this name; the signup one reads "you".
		const orgName = billing
			? orgIdentity(billing.org, { displayName: '', avatarUrl: null }).name
			: `@${orgSlug}`
		const subscriptionStatus = billing?.subscriptionStatus?.trim() || null
		const statusInfo = subscriptionStatus
			? describeSubscriptionStatus(subscriptionStatus)
			: null
		const paymentActionNeeded =
			subscriptionStatus === 'past_due' || subscriptionStatus === 'unpaid'
		const activeStripePlan = resolveActiveStripePlan(billing)
		const retiredPlan = isRetiredPaidSubscription(billing)
		const canSwitchToPro =
			retiredPlan &&
			billing != null &&
			billing.purchasablePlans.includes('pro') &&
			!paymentActionNeeded
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
			<AccountManagementShell
				maxWidth={layoutMaxWidths.content}
				busy={pending && appliedPayload !== null}
			>
				<AccountPageHeader
					title="Billing"
					description={
						billing && !billing.org.personal
							? `${orgName}'s Kody plan. Pro is billed per seat: every owner and member is one.`
							: 'Your plan, Stripe subscription, and referral link.'
					}
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
									? 'No Stripe customer is linked yet. Subscribe to Pro to create one and manage billing in Stripe.'
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
								{billing.usageHref ? (
									<a href={billing.usageHref} mix={css(mutedLinkCss)}>
										view usage
									</a>
								) : null}
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
							{billing.creditsEligible && billing.creditsHref ? (
								<p mix={css({ margin: 0 })}>
									<a href={billing.creditsHref} mix={css(primaryLinkCss)}>
										Manage credits
									</a>
								</p>
							) : null}
							{retiredPlan ? (
								<>
									<p mix={css(descriptionCss)}>Credits are available on Pro.</p>
									{canSwitchToPro ? (
										<div>
											<button
												type="button"
												disabled={checkoutPending !== null}
												mix={[
													on(
														'click',
														() =>
															void startCheckout(
																orgSlug,
																'pro',
																billing.stripeInterval ?? 'month',
																'',
																'page',
															),
													),
													css(primaryButtonCss),
												]}
											>
												{checkoutPending ? 'Opening Stripe…' : 'Switch to Pro'}
											</button>
										</div>
									) : null}
								</>
							) : null}
						</AccountManagementPanel>

						{billing.referralProgram ? (
							<AccountManagementPanel
								title="Refer a friend"
								description="Share your link. When someone new creates an account, verifies their email, and pays their first invoice, you both get one month of Pro. There is no cap."
							>
								<div
									mix={css({
										display: 'grid',
										gap: spacing.sm,
									})}
								>
									<div mix={css(accountFieldCss)}>
										<label
											for="referral-share-url"
											mix={css(accountFieldLabelCss)}
										>
											Your referral link
										</label>
										<div
											mix={css({
												display: 'flex',
												flexWrap: 'wrap',
												gap: spacing.sm,
												alignItems: 'center',
											})}
										>
											<input
												id="referral-share-url"
												type="url"
												readOnly
												value={billing.referralProgram.shareUrl}
												data-field-ring
												mix={css({
													...accountInputCss,
													flex: '1 1 16rem',
												})}
											/>
											<CopyTextButton
												value={billing.referralProgram.shareUrl}
												idleLabel="Copy link"
												variant="ghost"
												size="sm"
												ariaLabel="Copy referral link"
											/>
										</div>
									</div>
									<MetadataGrid
										items={[
											{
												label: 'Rewarded',
												value: String(billing.referralProgram.rewardedCount),
											},
											{
												label: 'Pending first payment',
												value: String(billing.referralProgram.pendingCount),
											},
											{
												label: 'Pro credit through',
												value: billing.referralProgram.creditExpiresAt
													? formatCancelDate(
															billing.referralProgram.creditExpiresAt,
														)
													: 'None yet',
											},
										]}
									/>
									{billing.referralProgram.referrals.length > 0 ? (
										<ul
											mix={css({
												margin: 0,
												padding: 0,
												listStyle: 'none',
												display: 'grid',
												gap: spacing.xs,
											})}
										>
											{billing.referralProgram.referrals.map((item) => (
												<li
													key={`${item.createdAt}:${item.refereeUsername ?? 'unknown'}`}
													mix={css(descriptionCss)}
												>
													{item.refereeUsername
														? `@${item.refereeUsername}`
														: 'A referred account'}{' '}
													{item.status === 'rewarded'
														? item.rewardedAt
															? `earned you a month on ${formatCancelDate(item.rewardedAt)}`
															: 'earned you a month'
														: 'signed up and has not paid yet'}
												</li>
											))}
										</ul>
									) : (
										<p mix={css(descriptionCss)}>
											No one has used your link yet.
										</p>
									)}
								</div>
							</AccountManagementPanel>
						) : null}

						{billing.cancelAt ? (
							<AccountManagementPanel
								title="Before you go"
								description="What led you to cancel? A sentence or two goes straight to the operator and shapes what gets fixed."
							>
								{cancellationFeedbackSent ? (
									<p mix={css(descriptionCss)}>
										Thank you — your feedback is on its way.
									</p>
								) : (
									<div mix={css({ display: 'grid', gap: spacing.sm })}>
										<label mix={css({ display: 'grid', gap: spacing.xs })}>
											<span mix={css(visuallyHiddenCss)}>
												Cancellation feedback
											</span>
											<textarea
												rows={3}
												maxLength={8000}
												placeholder="Too expensive, missing a feature, not useful enough…"
												value={cancellationFeedbackText}
												mix={[
													on('input', (event) => {
														cancellationFeedbackText = (
															event.currentTarget as HTMLTextAreaElement
														).value
														handle.update()
													}),
													css({
														padding: spacing.sm,
														borderRadius: radius.md,
														border: `1px solid ${colors.border}`,
														backgroundColor: colors.background,
														color: colors.text,
														fontFamily: 'inherit',
														fontSize: typography.fontSize.sm,
														resize: 'vertical' as const,
													}),
												]}
											/>
										</label>
										{cancellationFeedbackError ? (
											<AccountManagementMessage tone="error">
												{cancellationFeedbackError}
											</AccountManagementMessage>
										) : null}
										<div>
											<button
												type="button"
												disabled={cancellationFeedbackPending}
												mix={[
													on('click', () => void submitCancellationFeedback()),
													css(secondaryButtonCss),
												]}
											>
												{cancellationFeedbackPending
													? 'Sending…'
													: 'Send feedback'}
											</button>
										</div>
									</div>
								)}
							</AccountManagementPanel>
						) : null}

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
									{/* Soft-nav fetch follows the Stripe 302 and fails (KODY-88). */}
									<a
										href={billingPortalPath(orgSlug)}
										data-rmx-document
										mix={[
											on('click', (event) => {
												navigateBillingPortalOnPrimaryClick(event, orgSlug)
											}),
											css({
												...(statusInfo?.tone === 'action'
													? primaryButtonCss
													: secondaryButtonCss),
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

						{renderAccountBillingPlans({
							billing,
							activeStripePlan,
							paymentActionNeeded,
							checkoutPending,
							selectedIntervalByPlan,
							promoCode,
							checkoutError: planCheckoutError,
							onIntervalChange: (plan, interval) => {
								selectedIntervalByPlan[plan] = interval
								planCheckoutError = null
								handle.update()
							},
							onPromoCodeChange: (value) => {
								promoCode = value
								planCheckoutError = null
								handle.update()
							},
							onStartCheckout: (plan, interval) =>
								void startCheckout(
									orgSlug,
									plan,
									interval,
									promoCode,
									'plan-card',
								),
						})}
					</>
				) : null}

				<p mix={css({ margin: 0 })}>
					{billing && !billing.org.personal ? (
						<a href={`/@${orgSlug}`} mix={css(primaryLinkCss)}>
							Back to {orgName}
						</a>
					) : (
						<a href="/account" mix={css(primaryLinkCss)}>
							Back to account
						</a>
					)}
				</p>
			</AccountManagementShell>
		)
	}
}

const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
