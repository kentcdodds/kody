import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	formatSignedMicroUsd,
	parseDollarsToCents,
} from '#client/routes/credit-amount-input.ts'
import {
	creditAdminGrantNoteMaxLength,
	formatCents,
	formatMicroUsd,
	validateCreditAdminGrantCents,
} from '#universal/credits.ts'
import {
	type AccountCreditsLedgerItem,
	type AdminCreditWalletSummary,
} from '#universal/loader-data.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getAuthInputCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	MetadataGrid,
} from './account-management-components.tsx'
import { adminUserCreditsApiPath } from './admin-users-shared.ts'

const ledgerKindLabels: Record<AccountCreditsLedgerItem['kind'], string> = {
	top_up: 'Top-up',
	auto_refill: 'Auto-refill',
	admin_grant: 'Admin grant',
	debit: 'Debit',
}

type CreditsStatus = 'loading' | 'ready' | 'error'

/**
 * Credit wallet for the selected account: balance, eligibility, a grant
 * form, and the recent ledger. Keyed by `stableUserId` so switching users
 * starts from a fresh load.
 */
export function AdminUserCreditsPanel(
	handle: Handle<{ stableUserId: string; onGranted?: () => void }>,
) {
	let status: CreditsStatus = 'loading'
	let wallet: AdminCreditWalletSummary | null = null
	let loadStarted = false
	let amountText = ''
	let noteText = ''
	let granting = false
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'

	async function loadWallet(stableUserId: string) {
		try {
			const response = await fetch(
				`${adminUserCreditsApiPath}?stableUserId=${encodeURIComponent(stableUserId)}`,
				{ headers: { Accept: 'application/json' }, credentials: 'include' },
			)
			if (handle.signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AdminCreditWalletSummary | { ok: false; error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(
					(payload && 'error' in payload ? payload.error : null) ||
						'Unable to load credits for this account.',
				)
			}
			wallet = payload
			status = 'ready'
		} catch (error) {
			if (handle.signal.aborted) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load credits for this account.'
			messageTone = 'error'
		}
		handle.update()
	}

	async function submitGrant(event: SubmitEvent) {
		event.preventDefault()
		if (granting) return
		const amount = validateCreditAdminGrantCents(
			parseDollarsToCents(amountText) ?? Number.NaN,
		)
		if (!amount.ok) {
			message = amount.error
			messageTone = 'error'
			handle.update()
			return
		}
		const note = noteText.trim()
		if (note.length > creditAdminGrantNoteMaxLength) {
			message = `Keep the note under ${creditAdminGrantNoteMaxLength} characters.`
			messageTone = 'error'
			handle.update()
			return
		}
		granting = true
		message = null
		handle.update()
		try {
			const response = await fetch(adminUserCreditsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					stableUserId: handle.props.stableUserId,
					amountCents: amount.cents,
					...(note ? { note } : {}),
				}),
			})
			if (handle.signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AdminCreditWalletSummary | { ok: false; error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(
					(payload && 'error' in payload ? payload.error : null) ||
						'Unable to grant credits.',
				)
			}
			wallet = payload
			status = 'ready'
			amountText = ''
			noteText = ''
			message = `Granted ${formatCents(amount.cents)}.`
			messageTone = 'info'
			handle.props.onGranted?.()
		} catch (error) {
			if (handle.signal.aborted) return
			message =
				error instanceof Error ? error.message : 'Unable to grant credits.'
			messageTone = 'error'
		}
		granting = false
		handle.update()
	}

	return () => {
		if (!loadStarted && typeof document !== 'undefined') {
			loadStarted = true
			const stableUserId = handle.props.stableUserId
			handle.queueTask(() => loadWallet(stableUserId))
		}
		return (
			<AccountManagementPanel
				title="Credits"
				description="Prepaid wallet. Grants add to the balance immediately and are recorded with your username."
			>
				{status === 'loading' && !wallet ? (
					<p mix={css({ margin: 0, color: colors.textMuted })}>
						Loading credits…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				{wallet ? (
					<>
						<MetadataGrid
							items={[
								{
									label: 'Balance',
									value: (
										<span
											data-admin-credits-balance
											mix={css({
												fontVariantNumeric: 'tabular-nums',
												color:
													wallet.balanceMicroUsd < 0
														? colors.error
														: colors.text,
											})}
										>
											{formatMicroUsd(wallet.balanceMicroUsd)}
										</span>
									),
								},
								{
									label: 'Credit wallet',
									value: wallet.eligible
										? 'Eligible (Pro)'
										: `Not eligible (${wallet.plan})`,
								},
								{
									label: 'Admin eligibility',
									value: wallet.adminCreditsEligible ? 'On' : 'Off',
								},
								{
									label: 'Past include',
									value: wallet.unlocked
										? 'Runs on credits'
										: wallet.eligible
											? 'Stops (no credits)'
											: 'Plan hard caps',
								},
							]}
						/>
						<form
							noValidate
							aria-label="Grant credits"
							mix={[
								css({
									display: 'grid',
									gap: spacing.md,
									gridTemplateColumns: 'minmax(0, 10rem) minmax(0, 1fr) auto',
									alignItems: 'end',
									[mq.mobile]: { gridTemplateColumns: '1fr' },
								}),
								on('submit', (event: SubmitEvent) => void submitGrant(event)),
							]}
						>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Amount ($)</span>
								<input
									type="text"
									inputMode="decimal"
									autocomplete="off"
									value={amountText}
									disabled={granting}
									data-field-ring
									mix={[
										css(inputCss),
										on('input', (event) => {
											amountText = (event.currentTarget as HTMLInputElement)
												.value
											handle.update()
										}),
									]}
								/>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Note (optional)</span>
								<input
									type="text"
									autocomplete="off"
									maxLength={creditAdminGrantNoteMaxLength}
									value={noteText}
									disabled={granting}
									data-field-ring
									mix={[
										css(inputCss),
										on('input', (event) => {
											noteText = (event.currentTarget as HTMLInputElement).value
											handle.update()
										}),
									]}
								/>
							</label>
							<button
								type="submit"
								disabled={granting || amountText.trim() === ''}
								mix={css(primaryButtonCss)}
							>
								{granting ? 'Granting…' : 'Grant'}
							</button>
						</form>
						{wallet.recent.length === 0 ? (
							<p mix={css({ margin: 0, color: colors.textMuted })}>
								No credit activity yet.
							</p>
						) : (
							<ul
								aria-label="Recent credit activity"
								mix={css({
									margin: 0,
									padding: 0,
									listStyle: 'none',
									display: 'grid',
									gap: spacing.sm,
								})}
							>
								{wallet.recent.map((item) => (
									<li
										key={item.id}
										data-admin-credits-ledger-kind={item.kind}
										mix={css({
											display: 'grid',
											gap: '0.15rem',
											fontSize: typography.fontSize.sm,
										})}
									>
										<span
											mix={css({
												display: 'flex',
												flexWrap: 'wrap',
												gap: spacing.sm,
												fontVariantNumeric: 'tabular-nums',
											})}
										>
											<strong>{ledgerKindLabels[item.kind]}</strong>
											<span>{formatSignedMicroUsd(item.amountMicroUsd)}</span>
											<span mix={css({ color: colors.textMuted })}>
												{formatTimestampDate(item.createdAt)}
											</span>
										</span>
										{item.kind === 'admin_grant' ? (
											<span mix={css({ color: colors.textMuted })}>
												by {item.grantedByUsername ?? 'unknown admin'}
												{item.note ? ` — ${item.note}` : ''}
											</span>
										) : (
											<span mix={css({ color: colors.textMuted })}>
												{item.description}
											</span>
										)}
									</li>
								))}
							</ul>
						)}
					</>
				) : null}
			</AccountManagementPanel>
		)
	}
}

const inputCss = { ...getAuthInputCss(), width: '100%' }
const primaryButtonCss = getPillButtonCss({ size: 'sm' })
