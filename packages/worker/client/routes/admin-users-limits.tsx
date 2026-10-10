import { type Handle, css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { formatIntegerNumber } from '#client/charts/chart-theme.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	type AdminOrgLimitRow,
	type AdminOrgLimits,
} from '#universal/loader-data.ts'
import {
	isUnlimitedLimit,
	limitOverrideKeys,
	type LimitOverrideKey,
	type LimitOverrideValue,
} from '#universal/plans.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getAuthInputCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
} from './account-management-components.tsx'
import { adminOrgLimitsApiPath } from './admin-users-shared.ts'

type LimitsResponse =
	| (AdminOrgLimits & { ok: true })
	| { ok: false; error?: string }

function formatLimit(limit: number | null) {
	if (limit === null) return 'No window'
	return isUnlimitedLimit(limit) ? 'Unlimited' : formatIntegerNumber(limit)
}

function formatOverrideValue(value: LimitOverrideValue) {
	return value === 'unlimited' ? 'Unlimited' : formatIntegerNumber(value)
}

function parseValueText(text: string): LimitOverrideValue | null {
	const trimmed = text.trim().toLowerCase()
	if (trimmed === 'unlimited') return 'unlimited'
	const value = Number(trimmed.replaceAll(',', '').replaceAll('_', ''))
	return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Admin limit overrides for one org: plan vs effective caps, and a form to
 * set, change, or remove an override with a reason. Every change is
 * recorded in the org audit log.
 */
export function AdminOrgLimitsPanel(handle: Handle<{ orgId: string }>) {
	let limits: AdminOrgLimits | null = null
	let loadStarted = false
	let saving = false
	let key: LimitOverrideKey = limitOverrideKeys[0]
	let valueText = ''
	let expiresText = ''
	let reasonText = ''
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'

	function setError(error: unknown, fallback: string) {
		message = error instanceof Error ? error.message : fallback
		messageTone = 'error'
	}

	async function request(init?: RequestInit): Promise<AdminOrgLimits> {
		const url = init
			? adminOrgLimitsApiPath
			: `${adminOrgLimitsApiPath}?orgId=${encodeURIComponent(handle.props.orgId)}`
		const response = await fetch(url, {
			...init,
			headers: {
				Accept: 'application/json',
				...(init ? { 'Content-Type': 'application/json' } : {}),
			},
			credentials: 'include',
		})
		if (response.status === 401) {
			window.location.assign('/login')
			throw new Error('Signed out.')
		}
		const payload = await readJson<LimitsResponse>(response)
		if (!response.ok || !payload?.ok) {
			throw new Error(
				(payload && 'error' in payload ? payload.error : null) ||
					'Unable to load limits for this org.',
			)
		}
		return payload
	}

	async function load() {
		try {
			limits = await request()
		} catch (error) {
			if (handle.signal.aborted) return
			setError(error, 'Unable to load limits for this org.')
		}
		if (!handle.signal.aborted) handle.update()
	}

	async function save(change: {
		key: LimitOverrideKey
		value: LimitOverrideValue | null
		expiresAt: string | null
	}) {
		if (saving) return
		const reason = reasonText.trim()
		if (!reason) {
			message = 'A reason is required.'
			messageTone = 'error'
			handle.update()
			return
		}
		saving = true
		message = null
		handle.update()
		try {
			limits = await request({
				method: 'POST',
				body: JSON.stringify({
					orgId: handle.props.orgId,
					changes: [change],
					reason,
				}),
			})
			message = change.value === null ? 'Override removed.' : 'Override saved.'
			messageTone = 'info'
			valueText = ''
			expiresText = ''
		} catch (error) {
			if (handle.signal.aborted) return
			setError(error, 'Unable to save the override.')
		}
		saving = false
		handle.update()
	}

	function submit(event: SubmitEvent) {
		event.preventDefault()
		const value = parseValueText(valueText)
		if (value === null) {
			message = 'Enter a whole number or "unlimited".'
			messageTone = 'error'
			handle.update()
			return
		}
		const expiresAt = expiresText ? new Date(expiresText).toISOString() : null
		void save({ key, value, expiresAt })
	}

	function renderRow(row: AdminOrgLimitRow) {
		return (
			<tr key={row.key} data-admin-org-limit={row.key}>
				<td mix={css(cellCss)}>{row.label}</td>
				<td mix={css(numberCellCss)}>{formatLimit(row.planLimit)}</td>
				<td mix={css(numberCellCss)} data-admin-org-limit-effective>
					{formatLimit(row.effectiveLimit)}
				</td>
				<td mix={css(cellCss)}>
					{row.override ? (
						<span mix={css({ display: 'grid', gap: '0.15rem' })}>
							<span>
								{formatOverrideValue(row.override.value)}
								{row.override.active ? '' : ' (expired)'}
								{row.override.expiresAt
									? ` until ${formatTimestampDate(row.override.expiresAt)}`
									: ''}
							</span>
							<span mix={css({ color: colors.textMuted })}>
								{row.override.reason}
							</span>
							<button
								type="button"
								disabled={saving}
								mix={[
									css(removeButtonCss),
									on(
										'click',
										() =>
											void save({ key: row.key, value: null, expiresAt: null }),
									),
								]}
							>
								Remove
							</button>
						</span>
					) : (
						<span mix={css({ color: colors.textMuted })}>—</span>
					)}
				</td>
			</tr>
		)
	}

	return () => {
		if (!loadStarted && typeof document !== 'undefined') {
			loadStarted = true
			handle.queueTask(() => load())
		}
		return (
			<AccountManagementPanel
				title="Limit overrides"
				description="Raise any daily, weekly, or monthly cap for this org. The enforced limit is the larger of the plan limit and the override. Credits and billing are unchanged. Every change is recorded in the org audit log with your username and the reason."
			>
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				{limits ? (
					<>
						<div mix={css({ overflowX: 'auto' })}>
							<table
								aria-label="Org limits"
								mix={css({
									width: '100%',
									borderCollapse: 'collapse',
									fontSize: typography.fontSize.sm,
								})}
							>
								<thead>
									<tr>
										<th mix={css(headCss)}>Limit</th>
										<th mix={css(headCss)}>Plan</th>
										<th mix={css(headCss)}>Effective</th>
										<th mix={css(headCss)}>Override</th>
									</tr>
								</thead>
								<tbody>{limits.limits.map(renderRow)}</tbody>
							</table>
						</div>
						<form
							noValidate
							aria-label="Set limit override"
							mix={[
								css({
									display: 'grid',
									gap: spacing.md,
									gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
									alignItems: 'end',
									[mq.mobile]: { gridTemplateColumns: '1fr' },
								}),
								on('submit', (event: SubmitEvent) => submit(event)),
							]}
						>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Limit</span>
								<select
									value={key}
									disabled={saving}
									mix={[
										css(inputCss),
										on('change', (event) => {
											key = (event.currentTarget as HTMLSelectElement)
												.value as LimitOverrideKey
											handle.update()
										}),
									]}
								>
									{limits.limits.map((row) => (
										<option key={row.key} value={row.key}>
											{row.label}
										</option>
									))}
								</select>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Value (or "unlimited")</span>
								<input
									type="text"
									autocomplete="off"
									value={valueText}
									disabled={saving}
									data-field-ring
									mix={[
										css(inputCss),
										on('input', (event) => {
											valueText = (event.currentTarget as HTMLInputElement)
												.value
											handle.update()
										}),
									]}
								/>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Expires (optional)</span>
								<input
									type="datetime-local"
									value={expiresText}
									disabled={saving}
									data-field-ring
									mix={[
										css(inputCss),
										on('input', (event) => {
											expiresText = (event.currentTarget as HTMLInputElement)
												.value
											handle.update()
										}),
									]}
								/>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Reason (required)</span>
								<input
									type="text"
									autocomplete="off"
									maxLength={500}
									value={reasonText}
									disabled={saving}
									data-field-ring
									mix={[
										css(inputCss),
										on('input', (event) => {
											reasonText = (event.currentTarget as HTMLInputElement)
												.value
											handle.update()
										}),
									]}
								/>
							</label>
							<button
								type="submit"
								disabled={saving || valueText.trim() === ''}
								mix={css(primaryButtonCss)}
							>
								{saving ? 'Saving…' : 'Save override'}
							</button>
						</form>
					</>
				) : message ? null : (
					<p mix={css({ margin: 0, color: colors.textMuted })}>
						Loading limits…
					</p>
				)}
			</AccountManagementPanel>
		)
	}
}

const inputCss = { ...getAuthInputCss(), width: '100%' }
const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const removeButtonCss = {
	...getGhostButtonCss({ size: 'sm' }),
	justifySelf: 'start',
}
const headCss = {
	textAlign: 'left',
	padding: `${spacing.xs} ${spacing.sm}`,
	color: colors.textMuted,
	fontWeight: typography.fontWeight.medium,
} as const
const cellCss = {
	padding: `${spacing.xs} ${spacing.sm}`,
	verticalAlign: 'top',
	borderTop: `1px solid ${colors.border}`,
} as const
const numberCellCss = {
	...cellCss,
	fontVariantNumeric: 'tabular-nums',
} as const
