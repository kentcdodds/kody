import { css } from 'remix/ui'
import { chartColor, formatIntegerNumber } from '#client/charts/chart-theme.ts'
import { AccountManagementPanel } from '#client/routes/account-management-components.tsx'
import {
	warmWorkNudge,
	type AccountActivity,
	type CreditsAlarm,
	type IncludedComputeMeter,
} from '#universal/usage-presentation.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getAccentCalloutCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'

/**
 * Activity, included compute, and the credits alarm. `/account/credits` and
 * `/account/usage` render the same pieces from the same loader fields.
 */

function formatActivityMonth(month: string): string {
	const date = new Date(`${month}-01T00:00:00.000Z`)
	if (Number.isNaN(date.getTime())) return month
	return date.toLocaleString('en-US', {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	})
}

export function renderCreditsAlarm(
	alarm: CreditsAlarm | null,
	options: { showAction: boolean },
) {
	if (!alarm) return null
	return (
		<div
			role={alarm.tone === 'warn' ? 'alert' : 'status'}
			data-credits-alarm={alarm.kind}
			mix={css(
				getAccentCalloutCss({
					accentColor: alarm.tone === 'warn' ? chartColor.amber : undefined,
				}),
			)}
		>
			<p
				mix={css({
					margin: 0,
					fontWeight: typography.fontWeight.semibold,
					color: colors.text,
				})}
			>
				{alarm.title}
			</p>
			<p mix={css(descriptionCss)}>{alarm.body}</p>
			{options.showAction ? (
				<p mix={css({ margin: 0 })}>
					<a href={alarm.action.href} mix={css(primaryLinkCss)}>
						{alarm.action.label}
					</a>
				</p>
			) : null}
		</div>
	)
}

export function renderActivityPanel(
	activity: AccountActivity,
	options: { note?: string } = {},
) {
	return (
		<AccountManagementPanel
			title="Activity this month"
			description={`Code executions and runs in ${formatActivityMonth(activity.month)} (UTC). Updated hourly.`}
		>
			<dl data-account-activity mix={css(activityGridCss)}>
				{activity.metrics.map((item) => (
					<div
						key={item.metric}
						data-account-activity-metric={item.metric}
						mix={css(activityTileCss)}
					>
						<dt mix={css(activityLabelCss)}>{item.label}</dt>
						<dd mix={css(activityValueCss)}>
							{formatIntegerNumber(item.count)}
						</dd>
					</div>
				))}
			</dl>
			{options.note ? <p mix={css(descriptionCss)}>{options.note}</p> : null}
			<p mix={css(nudgeCss)}>{warmWorkNudge}</p>
		</AccountManagementPanel>
	)
}

export function renderIncludedComputePanel(input: {
	meters: Array<IncludedComputeMeter>
	summary: string
}) {
	if (input.meters.length === 0) return null
	const informational = input.meters.every((meter) => meter.informational)
	return (
		<AccountManagementPanel
			title={informational ? 'Behind the scenes' : 'Included compute'}
			description={input.summary}
		>
			<ul data-included-compute mix={css(meterListCss)}>
				{input.meters.map((meter) => (
					<li
						key={meter.resource}
						data-included-compute-meter={meter.resource}
						data-included-compute-tone={meter.tone}
						mix={css(meterRowCss)}
					>
						<div mix={css(meterHeadCss)}>
							<span
								mix={css({
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								})}
							>
								{meter.label}
							</span>
							<span
								data-included-compute-status
								mix={css({
									fontSize: typography.fontSize.sm,
									color:
										meter.tone === 'attention'
											? colors.warningText
											: colors.textMuted,
									fontWeight:
										meter.tone === 'attention'
											? typography.fontWeight.semibold
											: typography.fontWeight.normal,
								})}
							>
								{meter.status}
							</span>
						</div>
						{meter.informational ? null : (
							<div
								role="img"
								aria-label={`${meter.label}: ${meter.status}`}
								mix={css(meterTrackCss)}
							>
								<div
									data-included-compute-bar={meter.barPercent}
									mix={css({
										height: '100%',
										width: `${meter.barPercent}%`,
										background:
											meter.tone === 'attention'
												? chartColor.amber
												: chartColor.blue,
									})}
								/>
							</div>
						)}
						<p mix={css(meterCountsCss)}>
							{meter.informational
								? `${formatIntegerNumber(meter.current)} ${meter.unitLabel} this month`
								: `${formatIntegerNumber(meter.current)} of ${formatIntegerNumber(meter.include)} ${meter.unitLabel} included`}
						</p>
					</li>
				))}
			</ul>
		</AccountManagementPanel>
	)
}

const activityGridCss = {
	margin: 0,
	display: 'grid',
	gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
	gap: spacing.md,
	[mq.mobile]: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
}

const activityTileCss = {
	display: 'grid',
	gap: '0.25rem',
	padding: `${spacing.sm} ${spacing.md}`,
	borderRadius: radius.md,
	background: colors.primarySoftest,
	minWidth: 0,
}

const activityLabelCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const activityValueCss = {
	margin: 0,
	fontSize: 'clamp(1.5rem, 3vw, 2rem)',
	fontWeight: 760,
	letterSpacing: '-0.02em',
	fontVariantNumeric: 'tabular-nums' as const,
	color: colors.text,
}

const nudgeCss = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	textWrap: 'pretty' as const,
}

const meterListCss = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: spacing.md,
}

const meterRowCss = {
	display: 'grid',
	gap: '0.4rem',
}

const meterHeadCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	justifyContent: 'space-between',
	alignItems: 'baseline',
	gap: spacing.sm,
}

const meterTrackCss = {
	height: '8px',
	borderRadius: radius.md,
	background: colors.border,
	overflow: 'hidden',
}

const meterCountsCss = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	fontVariantNumeric: 'tabular-nums' as const,
}
