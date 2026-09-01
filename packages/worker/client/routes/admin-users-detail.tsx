import { css } from 'remix/ui'
import { type createDoubleCheck } from '#client/double-check.ts'
import { on } from '#client/event-mixin.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
	getPillButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	IdValue,
	MetadataGrid,
	TimestampValue,
	noticeCardCss,
} from './account-management-components.tsx'
import { RecordTable, recordBodyCss } from './record-table.tsx'
import { ChartLegend } from '#client/charts/chart-legend.tsx'
import { StackedBarChart } from '#client/charts/stacked-bar-chart.tsx'
import { chartColor, formatIntegerNumber } from '#client/charts/chart-theme.ts'
import {
	formatMonthKeyLabel,
	usageMetricSeries,
} from '#client/charts/usage-metric-series.ts'
import { type RoleName } from '#universal/permissions.ts'
import {
	type AdminPlanName,
	type AdminUserListItem,
	type AdminUserUsageLoaderData,
} from '#universal/loader-data.ts'
import { describeEmailVerificationDelivery } from '#universal/email-verification-delivery.ts'
import { formatUsageLimit, formatUsagePercent } from './admin-users-shared.ts'
import {
	dynamicWorkerCostFootnote,
	formatDynamicWorkerUsd,
} from '#universal/dynamic-worker-cost.ts'

const selectCss = getSelectCss()
const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

export type AdminUsersActionState =
	| 'idle'
	| 'assigning'
	| 'removing'
	| 'saving-plan'
	| 'moderating'
	| 'verifying'

export type AdminUserDetailProps = {
	selectedUser: AdminUserListItem
	availableRoles: Array<RoleName>
	availablePlans: Array<AdminPlanName>
	actionState: AdminUsersActionState
	selectedRoleToAssign: RoleName
	selectedPlanChoice: AdminPlanName
	mintedVerifyUrl: string | null
	mintedVerifyUrlForStableUserId: string | null
	markVerifiedCheck: ReturnType<typeof createDoubleCheck>
	usageStatus: 'loading' | 'ready' | 'error'
	usageMessage: string | null
	usageFailedForStableUserId: string | null
	selectedUsage: AdminUserUsageLoaderData | null
	onRoleToAssignChange: (role: RoleName) => void
	onSubmitRoleAction: (action: 'assign_role' | 'remove_role') => void
	onSubmitVerificationAction: (
		action: 'mark_email_verified' | 'mint_verify_url',
	) => void
	onPlanChoiceChange: (plan: AdminPlanName) => void
	onSubmitPlanAction: () => void
	onSubmitModerationAction: (
		action: 'suspend_user' | 'unsuspend_user' | 'resume_email_outbound',
	) => void
}

export function renderAdminUserDetail(props: AdminUserDetailProps) {
	const { selectedUser, actionState, selectedUsage, markVerifiedCheck } = props
	const isMutating = actionState !== 'idle'
	const usageMonthsAscending = selectedUsage
		? [...selectedUsage.monthUsage].reverse()
		: []
	return (
		<div mix={css(recordBodyCss)}>
			<div mix={css({ display: 'grid', gap: spacing.xs })}>
				<h2
					mix={css({
						margin: 0,
						fontSize: typography.fontSize.lg,
						fontWeight: typography.fontWeight.semibold,
					})}
				>
					{selectedUser.username}
				</h2>
				<p mix={css({ margin: 0, color: colors.textMuted })}>
					Account metadata only — no secrets, packages, or other user content
					appears on this page.
				</p>
			</div>
			<MetadataGrid
				items={[
					{ label: 'Email', value: selectedUser.email },
					{
						label: 'Email verified',
						value: selectedUser.email_verified
							? (selectedUser.email_verified_at ?? 'Verified')
							: 'No',
					},
					{
						label: 'Verification mail',
						value: selectedUser.email_verification_delivery
							? [
									selectedUser.email_verification_delivery.status,
									selectedUser.email_verification_delivery.class,
									selectedUser.email_verification_delivery_detail,
								]
									.filter(Boolean)
									.join(' · ')
							: 'Not tracked',
					},
					{
						label: 'First-touch UTMs',
						value:
							[
								selectedUser.utm_source && `source=${selectedUser.utm_source}`,
								selectedUser.utm_medium && `medium=${selectedUser.utm_medium}`,
								selectedUser.utm_campaign &&
									`campaign=${selectedUser.utm_campaign}`,
								selectedUser.utm_content &&
									`content=${selectedUser.utm_content}`,
								selectedUser.utm_term && `term=${selectedUser.utm_term}`,
							]
								.filter(Boolean)
								.join(' · ') || 'None',
					},
					{
						label: 'Landing path',
						value: selectedUser.first_touch_landing_path ?? 'None',
					},
					{
						label: 'Referrer',
						value: selectedUser.first_touch_referrer ?? 'None',
					},
					{
						label: 'First MCP connected',
						value: selectedUser.first_mcp_connected_at ?? 'Not yet',
					},
					{
						label: 'MCP client',
						value: selectedUser.mcp_client_name ?? 'Unknown',
					},
					{
						label: 'First execute',
						value: selectedUser.first_execute_at ?? 'Not yet',
					},
					{
						label: 'First saved package',
						value: selectedUser.first_saved_package_at ?? 'Not yet',
					},
					{
						label: 'Last active',
						value: selectedUser.last_active_at ?? 'Unknown',
					},
					{
						label: 'Stable user id',
						value: (
							<IdValue
								value={selectedUser.stableUserId}
								label="stable user id"
							/>
						),
					},
					{
						label: 'Roles',
						value:
							selectedUser.roles.length > 0
								? selectedUser.roles.join(', ')
								: 'None',
					},
					{
						label: 'Admin grant',
						value: selectedUser.plan ?? 'free',
					},
					{
						label: 'Subscription plan',
						value: selectedUser.stripePlan ?? 'None',
					},
					{
						label: 'Effective plan',
						value: selectedUser.effectivePlan ?? 'free',
					},
					{
						label: 'Stripe customer',
						value: selectedUser.stripeCustomerLinked ? 'Linked' : 'Not linked',
					},
					{
						label: 'Suspended',
						value: (
							<TimestampValue value={selectedUser.suspended_at} fallback="No" />
						),
					},
					{
						label: 'Outbound email',
						value: selectedUser.email_outbound_paused_at ? (
							<>
								Paused{' '}
								<TimestampValue value={selectedUser.email_outbound_paused_at} />
							</>
						) : (
							'Active'
						),
					},
					{
						label: 'Created',
						value: <TimestampValue value={selectedUser.created_at} />,
					},
					{
						label: 'Updated',
						value: <TimestampValue value={selectedUser.updated_at} />,
					},
				]}
			/>
			<AccountManagementPanel title="Manage roles">
				<div
					mix={css({
						display: 'grid',
						gap: spacing.md,
						gridTemplateColumns: 'minmax(0, 1fr) auto auto',
						alignItems: 'end',
						[mq.mobile]: { gridTemplateColumns: '1fr' },
					})}
				>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Role</span>
						<select
							data-field-ring
							value={props.selectedRoleToAssign}
							disabled={isMutating}
							aria-label="Role"
							mix={[
								on('change', (event) => {
									props.onRoleToAssignChange(
										event.currentTarget.value as RoleName,
									)
								}),
								css(selectCss),
							]}
						>
							{props.availableRoles.map((role) => (
								<option key={role} value={role}>
									{role}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						disabled={isMutating}
						mix={[
							on('click', () => props.onSubmitRoleAction('assign_role')),
							css(primaryButtonCss),
						]}
					>
						{actionState === 'assigning' ? 'Assigning…' : 'Assign'}
					</button>
					<button
						type="button"
						disabled={
							isMutating ||
							!selectedUser.roles.includes(props.selectedRoleToAssign)
						}
						mix={[
							on('click', () => props.onSubmitRoleAction('remove_role')),
							css(secondaryButtonCss),
						]}
					>
						{actionState === 'removing' ? 'Removing…' : 'Remove'}
					</button>
				</div>
			</AccountManagementPanel>
			{!selectedUser.email_verified ? (
				<AccountManagementPanel
					title="Email verification"
					description="Mark verified after the person proves they own the address (for example they mailed kody@ from it), or mint a one-time link to send over a path that is not kody.codes."
				>
					{selectedUser.email_verification_delivery ? (
						<p
							mix={css({
								margin: 0,
								color:
									describeEmailVerificationDelivery(
										selectedUser.email_verification_delivery,
									).tone === 'error'
										? colors.error
										: colors.textMuted,
							})}
						>
							{describeEmailVerificationDelivery(
								selectedUser.email_verification_delivery,
							).headline ?? selectedUser.email_verification_delivery.status}
							{selectedUser.email_verification_delivery_detail
								? ` — ${selectedUser.email_verification_delivery_detail}`
								: ''}
						</p>
					) : null}
					<div
						mix={css({
							display: 'flex',
							gap: spacing.md,
							flexWrap: 'wrap',
						})}
					>
						<button
							type="button"
							disabled={isMutating}
							mix={[
								...markVerifiedCheck.getButtonMix({
									on: {
										click: () =>
											props.onSubmitVerificationAction('mark_email_verified'),
									},
								}),
								css(primaryButtonCss),
							]}
						>
							{actionState === 'verifying'
								? 'Working…'
								: markVerifiedCheck.doubleCheck
									? 'Confirm mark verified'
									: 'Mark email verified'}
						</button>
						<button
							type="button"
							disabled={isMutating}
							mix={[
								on('click', () =>
									props.onSubmitVerificationAction('mint_verify_url'),
								),
								css(secondaryButtonCss),
							]}
						>
							{actionState === 'verifying' ? 'Working…' : 'Mint verify link'}
						</button>
					</div>
					{props.mintedVerifyUrl &&
					props.mintedVerifyUrlForStableUserId === selectedUser.stableUserId ? (
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>One-time verify URL</span>
							<input
								data-field-ring
								readOnly
								value={props.mintedVerifyUrl}
								aria-label="One-time verify URL"
								mix={css({
									width: '100%',
									fontFamily: typography.fontFamilyMono,
								})}
							/>
						</label>
					) : null}
				</AccountManagementPanel>
			) : null}
			<AccountManagementPanel
				title="Manage plan"
				description="Sets the admin grant (users.plan). Ordinary Stripe subscribers keep this as free; their paid tier lives on the subscription plan. The effective plan is the higher of the two."
			>
				<div
					mix={css({
						display: 'grid',
						gap: spacing.md,
						gridTemplateColumns: 'minmax(0, 1fr) auto',
						alignItems: 'end',
						[mq.mobile]: { gridTemplateColumns: '1fr' },
					})}
				>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Admin grant</span>
						<select
							data-field-ring
							disabled={isMutating}
							aria-label="Admin grant"
							mix={[
								on('change', (event) => {
									props.onPlanChoiceChange(
										event.currentTarget.value as AdminPlanName,
									)
								}),
								css(selectCss),
							]}
						>
							{props.availablePlans.map((plan) => (
								<option
									key={plan}
									value={plan}
									selected={plan === props.selectedPlanChoice}
								>
									{plan}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						disabled={
							isMutating ||
							props.selectedPlanChoice === (selectedUser.plan ?? 'free')
						}
						mix={[
							on('click', () => props.onSubmitPlanAction()),
							css(primaryButtonCss),
						]}
					>
						{actionState === 'saving-plan' ? 'Saving…' : 'Save grant'}
					</button>
				</div>
			</AccountManagementPanel>
			<AccountManagementPanel
				title="Moderation"
				description="Suspension blocks the account at the session, MCP, and email chokepoints. The outbound-email pause is set automatically after spam complaints or repeated bounces."
			>
				<div
					mix={css({
						display: 'flex',
						gap: spacing.md,
						flexWrap: 'wrap',
					})}
				>
					{selectedUser.suspended_at ? (
						<button
							type="button"
							disabled={isMutating}
							mix={[
								on('click', () =>
									props.onSubmitModerationAction('unsuspend_user'),
								),
								css(primaryButtonCss),
							]}
						>
							{actionState === 'moderating' ? 'Working…' : 'Clear suspension'}
						</button>
					) : (
						<button
							type="button"
							disabled={isMutating}
							mix={[
								on('click', () =>
									props.onSubmitModerationAction('suspend_user'),
								),
								css(secondaryButtonCss),
							]}
						>
							{actionState === 'moderating' ? 'Working…' : 'Suspend account'}
						</button>
					)}
					{selectedUser.email_outbound_paused_at ? (
						<button
							type="button"
							disabled={isMutating}
							mix={[
								on('click', () =>
									props.onSubmitModerationAction('resume_email_outbound'),
								),
								css(secondaryButtonCss),
							]}
						>
							{actionState === 'moderating'
								? 'Working…'
								: 'Resume outbound email'}
						</button>
					) : null}
				</div>
			</AccountManagementPanel>
			<AccountManagementPanel
				title="Usage & quotas"
				description="Metered usage rollups and entitlement consumption for this account. Warnings appear above 80% of a numeric limit."
			>
				{!selectedUsage && props.usageStatus === 'loading' ? (
					<p mix={css({ margin: 0, color: colors.textMuted })}>
						Loading usage…
					</p>
				) : null}
				{props.usageStatus === 'error' &&
				props.usageFailedForStableUserId === selectedUser.stableUserId &&
				props.usageMessage ? (
					<AccountManagementMessage tone="error">
						{props.usageMessage}
					</AccountManagementMessage>
				) : null}
				{selectedUsage ? (
					<>
						{selectedUsage.warnings.length > 0 ? (
							<div mix={css(noticeCardCss)}>
								<strong>Quota watch:</strong>{' '}
								{selectedUsage.warnings
									.map(
										(item) =>
											`${item.label} at ${formatUsagePercent(item.percentOfLimit)}`,
									)
									.join(', ')}
							</div>
						) : null}
						<div mix={css({ display: 'grid', gap: spacing.sm })}>
							<h3
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.base,
								})}
							>
								Cloudflare Dynamic Worker cost
							</h3>
							<p
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.sm,
									fontVariantNumeric: 'tabular-nums',
								})}
							>
								{formatDynamicWorkerUsd(
									selectedUsage.dynamicWorkerCost.estimatedGrossUsd,
								)}{' '}
								gross this month (
								{formatIntegerNumber(
									selectedUsage.dynamicWorkerCost.uniqueWorkerDays,
								)}{' '}
								unique worker-days)
							</p>
							<p
								mix={css({
									margin: 0,
									color: colors.textMuted,
									fontSize: typography.fontSize.xs,
								})}
							>
								{dynamicWorkerCostFootnote}
							</p>
						</div>
						<div mix={css({ display: 'grid', gap: spacing.md })}>
							<h3
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.base,
								})}
							>
								Monthly activity
							</h3>
							<StackedBarChart
								id="admin-user-usage"
								ariaLabel={`Metered events by month for ${selectedUsage.username}`}
								series={usageMetricSeries.map((entry) => ({
									label: entry.label,
									color: entry.color,
									values: usageMonthsAscending.map(
										(month) =>
											month.usage.find((row) => row.metric === entry.metric)
												?.eventCount ?? 0,
									),
								}))}
								xLabels={usageMonthsAscending.map((month) =>
									formatMonthKeyLabel(month.month),
								)}
								viewBoxWidth={560}
								height={200}
							/>
							<ChartLegend
								items={usageMetricSeries.map((entry) => ({
									label: entry.label,
									color: entry.color,
									value: formatIntegerNumber(
										selectedUsage.currentMonthUsage.find(
											(row) => row.metric === entry.metric,
										)?.eventCount ?? 0,
									),
								}))}
							/>
							<p
								mix={css({
									margin: 0,
									color: colors.textMuted,
									fontSize: typography.fontSize.xs,
								})}
							>
								Legend counts are for the current month (
								{selectedUsage.currentMonth}).
							</p>
						</div>
						<div mix={css({ display: 'grid', gap: spacing.md })}>
							<h3
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.base,
								})}
							>
								Entitlements
							</h3>
							<RecordTable
								mode="none"
								ariaLabel="Entitlement consumption"
								// The list is short and already sits inside an
								// expanded record; a nested scroller would be a
								// second thing to fight on the way down the page.
								scrollHeight="none"
								columns={[
									{
										key: 'resource',
										label: 'Resource',
										primary: true,
									},
									{ key: 'current', label: 'In use', align: 'end' },
									{ key: 'limit', label: 'Limit', align: 'end' },
									{ key: 'used', label: 'Used', align: 'end' },
								]}
								rows={selectedUsage.entitlementConsumption.map((item) => ({
									id: item.resource,
									cells: {
										resource: item.label,
										current:
											item.current === null
												? 'Not measured'
												: formatIntegerNumber(item.current),
										limit: formatUsageLimit(item.limit),
										used: (
											<span
												mix={css(
													item.overEightyPercent
														? {
																color: chartColor.amber,
																fontWeight: typography.fontWeight.semibold,
															}
														: {},
												)}
											>
												{formatUsagePercent(item.percentOfLimit)}
											</span>
										),
									},
								}))}
							/>
						</div>
					</>
				) : null}
			</AccountManagementPanel>
		</div>
	)
}
