import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from '#client/routes/account-management-components.tsx'
import { renderCreditsDebitRateCard } from '#client/routes/account-credits-rate-card.tsx'
import { RecordTable } from '#client/routes/record-table.tsx'
import { requestProCheckout } from '#client/routes/billing-checkout.ts'
import {
	formatCentsForInput,
	formatSignedMicroUsd,
	formatWholeDollars,
	parseDollarsToCents,
} from '#client/routes/credit-amount-input.ts'
import { formatIntegerNumber } from '#client/charts/chart-theme.ts'
import {
	creditLowBalanceCents,
	formatCents,
	formatMicroUsd,
	validateCreditAutoRefillSettings,
	validateCreditTopUpCents,
	type CreditAutoRefillSettings,
	type CreditNotifySettings,
} from '#universal/credits.ts'
import { type AccountCreditsLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getGhostButtonCss,
	getPillButtonCss,
	layoutMaxWidths,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'

const creditsApiPath = routes.accountCreditsApi.href()
const topUpApiPath = routes.accountCreditsTopUpPost.href()
const settingsApiPath = routes.accountCreditsSettingsPost.href()
const jsonRequestHeaders = {
	Accept: 'application/json',
	'Content-Type': 'application/json',
}

type SettingsDraft = {
	autoRefillEnabled: boolean
	thresholdText: string
	amountText: string
	monthlyCapText: string
	notify: CreditNotifySettings
}

function draftFromPayload(payload: AccountCreditsLoaderData): SettingsDraft {
	return {
		autoRefillEnabled: payload.autoRefill.enabled,
		thresholdText: formatCentsForInput(payload.autoRefill.thresholdCents),
		amountText: formatCentsForInput(payload.autoRefill.amountCents),
		monthlyCapText: formatCentsForInput(payload.autoRefill.monthlyCapCents),
		notify: { ...payload.notify },
	}
}

function readAutoRefillDraft(draft: SettingsDraft): CreditAutoRefillSettings {
	return {
		enabled: draft.autoRefillEnabled,
		thresholdCents: parseDollarsToCents(draft.thresholdText),
		amountCents: parseDollarsToCents(draft.amountText),
		monthlyCapCents: parseDollarsToCents(draft.monthlyCapText),
	}
}

async function fetchCredits(signal: AbortSignal) {
	return fetch(creditsApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
}

export async function accountCreditsRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetchCredits(signal)
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountCreditsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load credits.')
	}
	return { accountCredits: payload }
}

export function AccountCreditsRoute(handle: Handle) {
	let payload: AccountCreditsLoaderData | null = null
	let appliedSnapshot: AccountCreditsLoaderData | null = null
	let appliedError: Error | null = null
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let draft: SettingsDraft | null = null
	let customAmountText = ''
	let topUpPendingCents: number | null = null
	let saving = false
	let switchPending = false

	const creditsData = createRouteData({
		key: 'accountCredits',
		async load(_href, signal) {
			const response = await fetchCredits(signal)
			if (response.status === 401) return routeDataRedirect('/login')
			const next = await readJson<AccountCreditsLoaderData>(response)
			if (!response.ok || !next?.ok) {
				throw new Error('Unable to load credits.')
			}
			return next
		},
	})

	function applyPayload(next: AccountCreditsLoaderData) {
		payload = next
		draft = draftFromPayload(next)
		message = next.error ?? next.notice ?? null
		messageTone = next.error ? 'error' : 'info'
	}

	function setMessage(text: string, tone: 'info' | 'error') {
		message = text
		messageTone = tone
	}

	async function startTopUp(amountCents: number) {
		if (topUpPendingCents !== null) return
		const amount = validateCreditTopUpCents(amountCents)
		if (!amount.ok) {
			setMessage(amount.error, 'error')
			handle.update()
			return
		}
		topUpPendingCents = amount.cents
		message = null
		handle.update()
		try {
			const response = await fetch(topUpApiPath, {
				method: 'POST',
				headers: jsonRequestHeaders,
				credentials: 'include',
				body: JSON.stringify({ amountCents: amount.cents }),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const result = await readJson<{
				ok?: boolean
				url?: string
				error?: string
			}>(response)
			if (response.ok && result?.ok && typeof result.url === 'string') {
				window.location.assign(result.url)
				return
			}
			setMessage(
				result?.error || 'Unable to start checkout. Try again shortly.',
				'error',
			)
		} catch (error) {
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to start checkout. Try again shortly.',
				'error',
			)
		}
		topUpPendingCents = null
		handle.update()
	}

	async function saveSettings() {
		if (saving || !draft) return
		const autoRefill = validateCreditAutoRefillSettings(
			readAutoRefillDraft(draft),
		)
		if (!autoRefill.ok) {
			setMessage(autoRefill.error, 'error')
			handle.update()
			return
		}
		saving = true
		message = null
		handle.update()
		try {
			const response = await fetch(settingsApiPath, {
				method: 'POST',
				headers: jsonRequestHeaders,
				credentials: 'include',
				body: JSON.stringify({
					autoRefill: autoRefill.value,
					notify: draft.notify,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const next = await readJson<
				AccountCreditsLoaderData | { ok: false; error?: string }
			>(response)
			if (!response.ok || !next?.ok) {
				throw new Error(
					(next && 'error' in next ? next.error : null) ||
						'Unable to save credit settings.',
				)
			}
			applyPayload(next)
		} catch (error) {
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to save credit settings.',
				'error',
			)
		} finally {
			saving = false
			handle.update()
		}
	}

	async function switchToPro() {
		if (switchPending) return
		switchPending = true
		message = null
		handle.update()
		const result = await requestProCheckout()
		if (result.ok) {
			window.location.assign(result.url)
			return
		}
		switchPending = false
		setMessage(result.error, 'error')
		handle.update()
	}

	function updateDraft(patch: Partial<SettingsDraft>) {
		if (!draft) return
		draft = { ...draft, ...patch }
		handle.update()
	}

	function updateNotify(key: keyof CreditNotifySettings, value: boolean) {
		if (!draft) return
		updateDraft({ notify: { ...draft.notify, [key]: value } })
	}

	function renderAmountField(input: {
		id: string
		label: string
		value: string
		onInput: (value: string) => void
	}) {
		return (
			<div mix={css(accountFieldCss)}>
				<label for={input.id} mix={css(accountFieldLabelCss)}>
					{input.label}
				</label>
				<input
					id={input.id}
					type="text"
					inputMode="decimal"
					autocomplete="off"
					value={input.value}
					disabled={saving}
					data-field-ring
					mix={[
						css({ ...accountInputCss, maxWidth: '10rem' }),
						on('input', (event) => {
							input.onInput((event.currentTarget as HTMLInputElement).value)
						}),
					]}
				/>
			</div>
		)
	}

	function renderCheckbox(input: {
		label: string
		checked: boolean
		onChange: (checked: boolean) => void
	}) {
		return (
			<label
				mix={css({
					display: 'flex',
					gap: spacing.sm,
					alignItems: 'center',
					color: colors.text,
				})}
			>
				<input
					type="checkbox"
					checked={input.checked}
					disabled={saving}
					mix={[
						css({
							width: '1.1rem',
							height: '1.1rem',
							accentColor: colors.primary,
						}),
						on('change', (event) => {
							input.onChange((event.currentTarget as HTMLInputElement).checked)
						}),
					]}
				/>
				<span>{input.label}</span>
			</label>
		)
	}

	function renderIneligible(credits: AccountCreditsLoaderData) {
		return (
			<AccountManagementPanel>
				<p mix={css(descriptionCss)}>Credits are available on Pro.</p>
				<div mix={css(accountActionsCss)}>
					{credits.canSwitchToPro ? (
						<button
							type="button"
							disabled={switchPending}
							mix={[
								on('click', () => void switchToPro()),
								css(primaryButtonCss),
							]}
						>
							{switchPending ? 'Opening Stripe…' : 'Switch to Pro'}
						</button>
					) : (
						<a href={credits.billingHref} mix={css(primaryLinkCss)}>
							Go to billing
						</a>
					)}
				</div>
			</AccountManagementPanel>
		)
	}

	function renderPurchase(
		credits: AccountCreditsLoaderData,
		settings: SettingsDraft,
		topUpDisabled: boolean,
		customCents: number | null,
	) {
		return (
			<>
				<AccountManagementPanel title="Add credits">
					{!credits.configured ? (
						<AccountManagementMessage tone="info">
							Billing is not configured on this deployment.
						</AccountManagementMessage>
					) : null}
					<div mix={css(accountActionsCss)}>
						{credits.packsCents.map((cents) => (
							<button
								key={cents}
								type="button"
								disabled={topUpDisabled}
								mix={[
									on('click', () => void startTopUp(cents)),
									css(secondaryButtonCss),
								]}
							>
								{topUpPendingCents === cents
									? 'Opening Stripe…'
									: formatWholeDollars(cents)}
							</button>
						))}
					</div>
					<form
						noValidate
						mix={[
							css({
								display: 'flex',
								flexWrap: 'wrap',
								gap: spacing.sm,
								alignItems: 'end',
							}),
							on('submit', (event: SubmitEvent) => {
								event.preventDefault()
								void startTopUp(customCents ?? Number.NaN)
							}),
						]}
					>
						<div mix={css(accountFieldCss)}>
							<label
								for="credits-custom-amount"
								mix={css(accountFieldLabelCss)}
							>
								Custom amount ($)
							</label>
							<input
								id="credits-custom-amount"
								type="text"
								inputMode="decimal"
								autocomplete="off"
								placeholder={`${formatWholeDollars(credits.customMinCents)}–${formatWholeDollars(credits.customMaxCents)}`}
								value={customAmountText}
								disabled={topUpDisabled}
								data-field-ring
								mix={[
									css({ ...accountInputCss, maxWidth: '10rem' }),
									on('input', (event) => {
										customAmountText = (event.currentTarget as HTMLInputElement)
											.value
										handle.update()
									}),
								]}
							/>
						</div>
						<button
							type="submit"
							disabled={topUpDisabled || customCents === null}
							mix={css(primaryButtonCss)}
						>
							{topUpPendingCents !== null &&
							!credits.packsCents.includes(topUpPendingCents)
								? 'Opening Stripe…'
								: 'Add'}
						</button>
					</form>
				</AccountManagementPanel>

				<AccountManagementPanel
					title="Auto-refill"
					asForm
					onSubmit={(event) => {
						event.preventDefault()
						void saveSettings()
					}}
				>
					{renderCheckbox({
						label: 'Auto-refill',
						checked: settings.autoRefillEnabled,
						onChange: (checked) => updateDraft({ autoRefillEnabled: checked }),
					})}
					{settings.autoRefillEnabled ? (
						<>
							<div
								mix={css({
									display: 'grid',
									gridTemplateColumns: 'repeat(3, minmax(0, max-content))',
									gap: spacing.md,
									[mq.mobile]: { gridTemplateColumns: '1fr' },
								})}
							>
								{renderAmountField({
									id: 'credits-refill-threshold',
									label: 'When balance is at ($)',
									value: settings.thresholdText,
									onInput: (value) => updateDraft({ thresholdText: value }),
								})}
								{renderAmountField({
									id: 'credits-refill-amount',
									label: 'Refill ($)',
									value: settings.amountText,
									onInput: (value) => updateDraft({ amountText: value }),
								})}
								{renderAmountField({
									id: 'credits-refill-cap',
									label: 'Monthly cap ($)',
									value: settings.monthlyCapText,
									onInput: (value) => updateDraft({ monthlyCapText: value }),
								})}
							</div>
							<p mix={css(accountFieldNoteCss)}>
								Threshold at least{' '}
								{formatWholeDollars(credits.autoRefill.minThresholdCents)}.
								Refilled this month:{' '}
								{formatCents(credits.autoRefill.refilledThisMonthCents)}.
							</p>
							{!credits.autoRefill.hasPaymentMethod ? (
								<p mix={css(accountFieldNoteCss)}>
									Auto-refill starts after your first top-up saves a card.
								</p>
							) : null}
						</>
					) : null}
					<fieldset
						mix={css({
							margin: 0,
							padding: 0,
							border: 'none',
							display: 'grid',
							gap: spacing.xs,
						})}
					>
						<legend
							mix={css({ ...accountFieldLabelCss, marginBottom: spacing.xs })}
						>
							Email me when
						</legend>
						{settings.autoRefillEnabled ? (
							<>
								{renderCheckbox({
									label: 'Auto-refilled',
									checked: settings.notify.autoRefilled,
									onChange: (checked) => updateNotify('autoRefilled', checked),
								})}
								{renderCheckbox({
									label: 'Hit monthly cap',
									checked: settings.notify.monthlyCap,
									onChange: (checked) => updateNotify('monthlyCap', checked),
								})}
							</>
						) : (
							renderCheckbox({
								label: `Balance at or below ${formatWholeDollars(creditLowBalanceCents)}`,
								checked: settings.notify.lowBalance,
								onChange: (checked) => updateNotify('lowBalance', checked),
							})
						)}
					</fieldset>
					<div>
						<button type="submit" disabled={saving} mix={css(primaryButtonCss)}>
							{saving ? 'Saving…' : 'Save'}
						</button>
					</div>
				</AccountManagementPanel>
			</>
		)
	}

	function renderPurchaseUnavailable(credits: AccountCreditsLoaderData) {
		return (
			<AccountManagementPanel title="Add credits">
				<p mix={css(descriptionCss)}>Subscribe to Pro to add credits.</p>
				{credits.canSwitchToPro ? (
					<div mix={css(accountActionsCss)}>
						<button
							type="button"
							disabled={switchPending}
							mix={[
								on('click', () => void switchToPro()),
								css(primaryButtonCss),
							]}
						>
							{switchPending ? 'Opening Stripe…' : 'Subscribe to Pro'}
						</button>
					</div>
				) : null}
			</AccountManagementPanel>
		)
	}

	function renderEligible(
		credits: AccountCreditsLoaderData,
		settings: SettingsDraft,
	) {
		const topUpDisabled = !credits.configured || topUpPendingCents !== null
		const customCents = parseDollarsToCents(customAmountText)
		return (
			<>
				<AccountManagementPanel title="Balance">
					<p
						data-credits-balance
						mix={css({
							margin: 0,
							fontSize: 'clamp(2rem, 4vw, 2.6rem)',
							fontWeight: 760,
							letterSpacing: '-0.02em',
							fontVariantNumeric: 'tabular-nums',
							color: credits.balanceMicroUsd < 0 ? colors.error : colors.text,
						})}
					>
						{formatMicroUsd(credits.balanceMicroUsd)}
					</p>
					{credits.unlocked || credits.canBuyCredits ? (
						<p mix={css(descriptionCss)}>
							{credits.unlocked
								? 'Higher limits are on.'
								: 'Add credits to lift your limits.'}
						</p>
					) : null}
				</AccountManagementPanel>

				{credits.canBuyCredits
					? renderPurchase(credits, settings, topUpDisabled, customCents)
					: renderPurchaseUnavailable(credits)}

				<AccountManagementPanel title="Limits">
					<RecordTable
						mode="none"
						ariaLabel="Limits with and without credits"
						scrollHeight="none"
						columns={[
							{ key: 'label', label: 'Limit', primary: true },
							{ key: 'base', label: 'With $0', align: 'end' },
							{ key: 'unlocked', label: 'With credits', align: 'end' },
						]}
						rows={credits.limits.map((limit) => ({
							id: limit.resource,
							cells: {
								label: limit.label,
								base: formatIntegerNumber(limit.base),
								unlocked: (
									<span
										mix={css(
											credits.unlocked
												? {
														color: colors.primaryText,
														fontWeight: typography.fontWeight.semibold,
													}
												: {},
										)}
									>
										{formatIntegerNumber(limit.unlocked)}
									</span>
								),
							},
						}))}
					/>
				</AccountManagementPanel>

				{renderCreditsDebitRateCard(credits.debitMeters)}

				<AccountManagementPanel title="Recent">
					{credits.recent.length === 0 ? (
						<p mix={css(descriptionCss)}>No activity yet.</p>
					) : (
						<ul
							mix={css({
								margin: 0,
								padding: 0,
								listStyle: 'none',
								display: 'grid',
								gap: spacing.xs,
							})}
						>
							{credits.recent.map((item) => (
								<li
									key={item.id}
									data-credits-ledger-kind={item.kind}
									mix={css({
										display: 'grid',
										gridTemplateColumns: 'minmax(0, 1fr) auto auto',
										gap: spacing.md,
										alignItems: 'baseline',
										fontSize: typography.fontSize.sm,
									})}
								>
									<span mix={css({ color: colors.text, minWidth: 0 })}>
										{item.description}
									</span>
									<span
										mix={css({
											fontVariantNumeric: 'tabular-nums',
											color:
												item.amountMicroUsd > 0
													? colors.primaryText
													: colors.text,
										})}
									>
										{formatSignedMicroUsd(item.amountMicroUsd)}
									</span>
									<span
										mix={css({
											color: colors.textMuted,
											fontVariantNumeric: 'tabular-nums',
											whiteSpace: 'nowrap',
										})}
									>
										{formatTimestampDate(item.createdAt)}
									</span>
								</li>
							))}
						</ul>
					)}
				</AccountManagementPanel>
			</>
		)
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = creditsData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedSnapshot) {
			appliedSnapshot = snapshot.data
			applyPayload(snapshot.data)
		}
		if (snapshot.error && snapshot.error !== appliedError) {
			appliedError = snapshot.error
			setMessage(snapshot.error.message, 'error')
		}
		const pending = snapshot.kind === 'pending'
		const credits = payload

		return (
			<AccountManagementShell
				maxWidth={layoutMaxWidths.content}
				busy={(pending && credits !== null) || saving}
			>
				<AccountPageHeader
					title="Credits"
					description="Prepaid balance for Pro. Above $0, higher limits apply."
					currentHref={currentHref}
				/>
				{pending && credits === null ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading credits…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				{credits && draft
					? credits.eligible
						? renderEligible(credits, draft)
						: renderIneligible(credits)
					: null}
			</AccountManagementShell>
		)
	}
}

const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
