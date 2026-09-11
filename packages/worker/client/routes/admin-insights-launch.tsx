import { css } from 'remix/ui'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import { DonutChart } from '#client/charts/donut-chart.tsx'
import { StatCard } from '#client/charts/stat-card.tsx'
import {
	chartColor,
	formatIntegerNumber,
	formatPercentShare,
} from '#client/charts/chart-theme.ts'
import {
	type AdminInsightsLaunchFunnelStep,
	type AdminInsightsLaunchSignals,
} from '#universal/loader-data.ts'
import { formatPlanLabel, formatUsdFromCents } from './admin-insights-shared.ts'
import { ChartCard } from './admin-insights-sections.tsx'

const launchFunnelLabels: Record<
	AdminInsightsLaunchFunnelStep['step'],
	string
> = {
	signed_up: 'Signed up',
	email_verified: 'Verified email',
	first_mcp: 'Connected MCP',
	first_search: 'First search',
	first_execute: 'First execute',
	first_saved_package: 'Saved a package',
}

const mcpClientColors: Record<string, string> = {
	cursor: chartColor.blue,
	'claude-code': chartColor.amber,
	codex: chartColor.violet,
	'claude-desktop': chartColor.rose,
	chatgpt: chartColor.emerald,
	other: chartColor.cyan,
}

function formatOpenedDay(day: string) {
	const [year, month, dayOfMonth] = day.split('-')
	if (!year || !month || !dayOfMonth) return day
	return `${year}-${month}-${dayOfMonth}`
}

function renderLaunchFunnel(input: {
	id: string
	steps: Array<AdminInsightsLaunchFunnelStep>
	ariaLabel: string
}) {
	const total = input.steps[0]?.users ?? 0
	return (
		<div mix={css({ display: 'grid', gap: spacing.sm })}>
			{input.steps.map((entry) => {
				const share = total > 0 ? entry.users / total : 0
				return (
					<div
						key={`${input.id}-${entry.step}`}
						mix={css({ display: 'grid', gap: spacing.xs })}
					>
						<div
							mix={css({
								display: 'flex',
								justifyContent: 'space-between',
								gap: spacing.sm,
								fontSize: typography.fontSize.sm,
								color: colors.text,
							})}
						>
							<span>{launchFunnelLabels[entry.step]}</span>
							<span mix={css({ color: colors.textMuted })}>
								{formatIntegerNumber(entry.users)} · {formatPercentShare(share)}
							</span>
						</div>
						<div
							role="img"
							aria-label={`${launchFunnelLabels[entry.step]}: ${entry.users} users, ${formatPercentShare(share)} of signups`}
							mix={css({
								height: '10px',
								borderRadius: '999px',
								background: colors.border,
								overflow: 'hidden',
							})}
						>
							<div
								mix={css({
									height: '100%',
									width: `${Math.round(share * 100)}%`,
									background:
										entry.step === 'first_saved_package'
											? chartColor.emerald
											: chartColor.blue,
								})}
							/>
						</div>
					</div>
				)
			})}
		</div>
	)
}

function renderPlanTable(input: {
	ariaLabel: string
	rows: Array<{
		label: string
		slices: Array<{ plan: string; count: number }>
	}>
}) {
	const plans = ['free', 'standard', 'pro', 'max', 'none']
	const present = new Set(
		input.rows.flatMap((row) => row.slices.map((slice) => slice.plan)),
	)
	const columns = plans.filter((plan) => present.has(plan))
	return (
		<table
			aria-label={input.ariaLabel}
			mix={css({
				width: '100%',
				borderCollapse: 'collapse',
				fontSize: typography.fontSize.sm,
			})}
		>
			<caption
				mix={css({
					captionSide: 'top',
					textAlign: 'left',
					color: colors.textMuted,
					paddingBottom: spacing.xs,
				})}
			>
				Manual `plan` is the admin grant. `stripePlan` is the paid Stripe
				subscription. `effectivePlan` is the entitlement after overlays.
			</caption>
			<thead>
				<tr>
					<th
						scope="col"
						mix={css({
							textAlign: 'left',
							padding: `${spacing.xs} ${spacing.sm}`,
							color: colors.textMuted,
							fontWeight: typography.fontWeight.medium,
						})}
					>
						Source
					</th>
					{columns.map((plan) => (
						<th
							key={plan}
							scope="col"
							mix={css({
								textAlign: 'right',
								padding: `${spacing.xs} ${spacing.sm}`,
								color: colors.textMuted,
								fontWeight: typography.fontWeight.medium,
							})}
						>
							{formatPlanLabel(plan)}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{input.rows.map((row) => {
					const byPlan = new Map(
						row.slices.map((slice) => [slice.plan, slice.count]),
					)
					return (
						<tr key={row.label}>
							<th
								scope="row"
								mix={css({
									textAlign: 'left',
									padding: `${spacing.xs} ${spacing.sm}`,
									fontWeight: typography.fontWeight.medium,
								})}
							>
								{row.label}
							</th>
							{columns.map((plan) => (
								<td
									key={plan}
									mix={css({
										textAlign: 'right',
										padding: `${spacing.xs} ${spacing.sm}`,
										fontVariantNumeric: 'tabular-nums',
										color: colors.textMuted,
									})}
								>
									{formatIntegerNumber(byPlan.get(plan) ?? 0)}
								</td>
							))}
						</tr>
					)
				})}
			</tbody>
		</table>
	)
}

export function renderLaunchSignals(signals: AdminInsightsLaunchSignals) {
	const paidLabel =
		signals.unpricedPaidSubscribers > 0
			? `${formatIntegerNumber(signals.paidSubscribers)} paid · ${formatIntegerNumber(signals.unpricedPaidSubscribers)} unpriced`
			: `${formatIntegerNumber(signals.paidSubscribers)} paid Standard/Pro`
	const sinceOpenSignups =
		signals.activation.sinceOpen.find((step) => step.step === 'signed_up')
			?.users ?? 0

	return (
		<>
			<div
				mix={css({
					display: 'grid',
					gap: spacing.md,
					gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
					[mq.tablet]: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
					[mq.mobile]: { gridTemplateColumns: 'minmax(0, 1fr)' },
				})}
			>
				<StatCard
					id="stat-mrr"
					label="Rough MRR"
					value={formatUsdFromCents(signals.mrrUsdCents)}
					sub={paidLabel}
					color={chartColor.emerald}
				/>
				<StatCard
					id="stat-active"
					label="Active users"
					value={formatIntegerNumber(signals.activeUsers.hours24)}
					sub={`${formatIntegerNumber(signals.activeUsers.hours48)} in 48h · ${formatIntegerNumber(signals.activeUsers.days7)} in 7d · UTC days from last_active_at`}
					color={chartColor.blue}
					sparkValues={[
						signals.activeUsers.hours24,
						signals.activeUsers.hours48,
						signals.activeUsers.days7,
					]}
				/>
				<StatCard
					id="stat-since-open"
					label="New since open"
					value={formatIntegerNumber(sinceOpenSignups)}
					sub={`Cohort from ${formatOpenedDay(signals.openedDay)}`}
					color={chartColor.violet}
				/>
				<StatCard
					id="stat-feedback"
					label="Open feedback"
					value={formatIntegerNumber(signals.openPlatformFeedback)}
					sub="Open items in Platform feedback"
					color={chartColor.amber}
				/>
			</div>

			<div
				mix={css({
					display: 'grid',
					gap: spacing.lg,
					gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
					[mq.tablet]: { gridTemplateColumns: 'minmax(0, 1fr)' },
				})}
			>
				<ChartCard
					title="Launch activation"
					sub="Signup through first saved package from user stamps. Not effective-plan overlays and not RunLog package-activation."
					span={6}
				>
					{renderLaunchFunnel({
						id: 'overall',
						steps: signals.activation.overall,
						ariaLabel: 'Overall launch activation funnel',
					})}
				</ChartCard>
				<ChartCard
					title="Since open"
					sub={`Same funnel for accounts created on or after ${formatOpenedDay(signals.openedDay)}.`}
					span={6}
				>
					{renderLaunchFunnel({
						id: 'since-open',
						steps: signals.activation.sinceOpen,
						ariaLabel: 'Since-open launch activation funnel',
					})}
				</ChartCard>

				<ChartCard
					title="Paid subscriptions"
					sub="Active Standard and Pro from stripe_plan + stripe_price_id. Yearly counts at list/12. Gift and referral overlays are excluded."
					span={6}
				>
					{signals.paidSlices.length === 0 ? (
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							No paid Stripe subscriptions yet.
						</p>
					) : (
						<table
							aria-label="Paid subscriptions by plan and interval"
							mix={css({
								width: '100%',
								borderCollapse: 'collapse',
								fontSize: typography.fontSize.sm,
							})}
						>
							<thead>
								<tr>
									<th
										scope="col"
										mix={css({
											textAlign: 'left',
											padding: `${spacing.xs} ${spacing.sm}`,
											color: colors.textMuted,
											fontWeight: typography.fontWeight.medium,
										})}
									>
										Plan
									</th>
									<th
										scope="col"
										mix={css({
											textAlign: 'right',
											padding: `${spacing.xs} ${spacing.sm}`,
											color: colors.textMuted,
											fontWeight: typography.fontWeight.medium,
										})}
									>
										Subs
									</th>
									<th
										scope="col"
										mix={css({
											textAlign: 'right',
											padding: `${spacing.xs} ${spacing.sm}`,
											color: colors.textMuted,
											fontWeight: typography.fontWeight.medium,
										})}
									>
										MRR
									</th>
								</tr>
							</thead>
							<tbody>
								{signals.paidSlices.map((slice) => (
									<tr key={`${slice.plan}-${slice.interval}`}>
										<td mix={css({ padding: `${spacing.xs} ${spacing.sm}` })}>
											{formatPlanLabel(slice.plan)} · {slice.interval}
										</td>
										<td
											mix={css({
												padding: `${spacing.xs} ${spacing.sm}`,
												textAlign: 'right',
												fontVariantNumeric: 'tabular-nums',
											})}
										>
											{formatIntegerNumber(slice.subscribers)}
										</td>
										<td
											mix={css({
												padding: `${spacing.xs} ${spacing.sm}`,
												textAlign: 'right',
												fontVariantNumeric: 'tabular-nums',
												color: colors.textMuted,
											})}
										>
											{formatUsdFromCents(slice.mrrUsdCents)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</ChartCard>
				<ChartCard
					title="Plan sources"
					sub={
						signals.overlayStandard > 0
							? `${formatIntegerNumber(signals.overlayStandard)} effective Standard come from gift or referral overlays.`
							: 'Manual grant, Stripe subscription, and effective entitlement stay separate.'
					}
					span={6}
				>
					{renderPlanTable({
						ariaLabel: 'Users by plan source',
						rows: [
							{ label: 'plan', slices: signals.manualPlans },
							{ label: 'stripePlan', slices: signals.stripePlans },
							{ label: 'effectivePlan', slices: signals.effectivePlans },
						],
					})}
				</ChartCard>

				<ChartCard
					title="MCP client mix"
					sub="First-touch mcp_client_name classified into Cursor, Claude Code, Codex, and other hosts."
					span={6}
				>
					<DonutChart
						ariaLabel="First-touch MCP clients"
						centerLabel="connected"
						emptyText="Nobody has connected an MCP client yet."
						slices={signals.mcpClients.map((slice, index) => ({
							label: slice.label,
							value: slice.count,
							color:
								((slice.kind && mcpClientColors[slice.kind]) ||
									[chartColor.cyan, chartColor.lime, chartColor.fuchsia][
										index % 3
									]) ??
								chartColor.cyan,
						}))}
					/>
				</ChartCard>
				<ChartCard
					title="Entitlement ladder"
					sub={`${formatIntegerNumber(signals.paidEntitlementLadders.legacy)} paid legacy · ${formatIntegerNumber(signals.paidEntitlementLadders.public)} paid public.`}
					span={6}
				>
					<DonutChart
						ariaLabel="Users by entitlement ladder"
						centerLabel="users"
						slices={[
							{
								label: 'Public',
								value: signals.entitlementLadders.public,
								color: chartColor.blue,
							},
							{
								label: 'Legacy',
								value: signals.entitlementLadders.legacy,
								color: chartColor.amber,
							},
						]}
					/>
				</ChartCard>
			</div>
		</>
	)
}
