import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
	AccountManagementMessage,
	AccountManagementPanel,
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
import {
	type AccountUsageCredits,
	type AccountUsageCreditsWallet,
	type AccountUsageLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getGhostButtonCss,
	getPillButtonCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'

/** Anchor for `/account/usage#credits` (`accountCreditsPath`). */
const creditsSectionId = 'credits'
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

function draftFromWallet(wallet: AccountUsageCreditsWallet): SettingsDraft {
	return {
		autoRefillEnabled: wallet.autoRefill.enabled,
		thresholdText: formatCentsForInput(wallet.autoRefill.thresholdCents),
		amountText: formatCentsForInput(wallet.autoRefill.amountCents),
		monthlyCapText: formatCentsForInput(wallet.autoRefill.monthlyCapCents),
		notify: { ...wallet.notify },
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

type AccountUsageCreditsSectionProps = {
	credits: AccountUsageCredits
	/** Page-load outcome for credits (top-up added, top-up failed). */
	notice?: string
	error?: string
	/** Saving credit settings returns the whole refreshed usage payload. */
	onUsageChange: (next: AccountUsageLoaderData) => void
}

/**
 * The Credits section at the end of `/account/usage`. Activity, included
 * compute, and the credits alarm render once above it, so this section is
 * only the wallet: balance, add credits, auto-refill, how far credits go,
 * the debit rate card, and credit history. Without a wallet it is one
 * switch-to-Pro prompt with no purchase UI.
 */
export function AccountUsageCreditsSection(
	handle: Handle<AccountUsageCreditsSectionProps>,
) {
	let appliedCredits: AccountUsageCredits | null = null
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let draft: SettingsDraft | null = null
	let customAmountText = ''
	let topUpPendingCents: number | null = null
	let saving = false
	let switchPending = false

	function applyCredits(credits: AccountUsageCredits) {
		appliedCredits = credits
		draft = credits.eligible ? draftFromWallet(credits) : null
		message = handle.props.error ?? handle.props.notice ?? null
		messageTone = handle.props.error ? 'error' : 'info'
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
				AccountUsageLoaderData | { ok: false; error?: string }
			>(response)
			if (!response.ok || !next?.ok) {
				throw new Error(
					(next && 'error' in next ? next.error : null) ||
						'Unable to save credit settings.',
				)
			}
			saving = false
			handle.props.onUsageChange(next)
			return
		} catch (error) {
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to save credit settings.',
				'error',
			)
		}
		saving = false
		handle.update()
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

	function renderMessage() {
		return message ? (
			<AccountManagementMessage tone={messageTone}>
				{message}
			</AccountManagementMessage>
		) : null
	}

	function renderSwitchToProButton(label: string) {
		return (
			<button
				type="button"
				disabled={switchPending}
				mix={[on('click', () => void switchToPro()), css(primaryButtonCss)]}
			>
				{switchPending ? 'Opening Stripe…' : label}
			</button>
		)
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

	function renderIneligible(
		credits: Extract<AccountUsageCredits, { eligible: false }>,
	) {
		return (
			<AccountManagementPanel
				id={creditsSectionId}
				title="Credits"
				description="Credits are available on Pro. Pro usage past its monthly include runs on prepaid credits and stops when they run out."
			>
				{renderMessage()}
				<div mix={css(accountActionsCss)}>
					{credits.canSwitchToPro ? (
						renderSwitchToProButton('Switch to Pro')
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
		credits: AccountUsageCreditsWallet,
		settings: SettingsDraft,
	) {
		const topUpDisabled = !credits.configured || topUpPendingCents !== null
		const customCents = parseDollarsToCents(customAmountText)
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

	function renderPurchaseUnavailable(credits: AccountUsageCreditsWallet) {
		return (
			<AccountManagementPanel title="Add credits">
				<p mix={css(descriptionCss)}>Subscribe to Pro to add credits.</p>
				{credits.canSwitchToPro ? (
					<div mix={css(accountActionsCss)}>
						{renderSwitchToProButton('Subscribe to Pro')}
					</div>
				) : null}
			</AccountManagementPanel>
		)
	}

	function renderWallet(
		credits: AccountUsageCreditsWallet,
		settings: SettingsDraft,
	) {
		return (
			<>
				<AccountManagementPanel
					id={creditsSectionId}
					title="Credits"
					description="Prepaid balance for Pro. Usage past your monthly include is charged here until it runs out."
				>
					{renderMessage()}
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
					<p mix={css(descriptionCss)} data-credits-balance-note>
						{credits.hasCredits
							? 'Usage past your monthly include is charged from these credits.'
							: 'With no credits left, usage past your monthly include stops. Add credits to keep going.'}
					</p>
				</AccountManagementPanel>

				{credits.canBuyCredits
					? renderPurchase(credits, settings)
					: renderPurchaseUnavailable(credits)}

				<AccountManagementPanel title="How far credits go">
					<p mix={css(descriptionCss)}>
						Pro includes the first column. Past it, usage runs on credits up to
						the second column, and stops when credits run out.
					</p>
					<RecordTable
						mode="none"
						ariaLabel="Included limits and how far credits go"
						scrollHeight="none"
						columns={[
							{ key: 'label', label: 'Limit', primary: true },
							{ key: 'included', label: 'Included', align: 'end' },
							{
								key: 'creditsCeiling',
								label: 'On credits, up to',
								align: 'end',
							},
						]}
						rows={credits.limits.map((limit) => ({
							id: limit.resource,
							cells: {
								label: limit.label,
								included: formatIntegerNumber(limit.included),
								creditsCeiling: (
									<span
										mix={css(
											credits.hasCredits
												? {
														color: colors.primaryText,
														fontWeight: typography.fontWeight.semibold,
													}
												: {},
										)}
									>
										{formatIntegerNumber(limit.creditsCeiling)}
									</span>
								),
							},
						}))}
					/>
				</AccountManagementPanel>

				{renderCreditsDebitRateCard(credits.debitMeters, {
					pastIncludeNeedsAttention: !credits.hasCredits,
				})}

				<AccountManagementPanel title="Credit history">
					{credits.recent.length === 0 ? (
						<p mix={css(descriptionCss)}>No credit activity yet.</p>
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
		const { credits } = handle.props
		if (credits !== appliedCredits) applyCredits(credits)
		if (!credits.eligible) return renderIneligible(credits)
		return draft ? renderWallet(credits, draft) : null
	}
}

const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
