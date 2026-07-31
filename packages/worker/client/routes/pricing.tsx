import { type Handle, css } from 'remix/ui'
import { planLimits, type PlanLimits } from '#worker/entitlements/plans.ts'
import { colors, radius, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	primaryLinkCss,
	stackedPageCss,
} from '#client/styles/style-primitives.ts'

type LimitRow = {
	label: string
	format?: (value: number) => string
	key: keyof PlanLimits
}

const count = new Intl.NumberFormat('en-US')

const limitRows: ReadonlyArray<LimitRow> = [
	{ label: 'Saved packages', key: 'maxSavedPackages' },
	{ label: 'Scheduled jobs', key: 'maxScheduledJobs' },
	{ label: 'Running package services', key: 'maxPackageServices' },
	{
		label: 'Persistent package services',
		key: 'packageServicePersistentAllowed',
		format: (value) => (value === 1 ? 'Allowed' : 'Not included'),
	},
	{ label: 'Active repo sessions', key: 'maxRepoSessions' },
	{ label: 'Email sends per day', key: 'maxEmailSendsPerDay' },
	{ label: 'Email receives per day', key: 'maxEmailReceivesPerDay' },
	{ label: 'Stored email messages', key: 'maxStoredEmailMessages' },
	{
		label: 'Maximum email message size',
		key: 'maxEmailMessageBytes',
		format: formatBytes,
	},
	{ label: 'Stored secrets', key: 'maxSecrets' },
	{
		label: 'Durable storage',
		key: 'maxStorageBytes',
		format: formatBytes,
	},
	{ label: 'Concurrent workflows', key: 'maxConcurrentWorkflows' },
	{ label: 'Execute calls per day', key: 'maxExecuteCallsPerDay' },
	{ label: 'Outbound fetches per day', key: 'maxOutboundFetchesPerDay' },
]

export function PricingRoute(_handle: Handle) {
	return () => (
		<section mix={css(pageCss)}>
			<header mix={css(pageHeaderCss)}>
				<h1 mix={css(pageTitleCss)}>Pricing</h1>
				<p mix={css(pageDescriptionCss)}>
					Start free. Pro is $5 per month when you need more room to run.
				</p>
			</header>

			<div mix={css(planGridCss)}>
				<section mix={css(planCardCss)}>
					<div>
						<h2 mix={css(planTitleCss)}>Free</h2>
						<p mix={css(priceCss)}>$0</p>
					</div>
					<p mix={css(descriptionCss)}>
						Enough to build useful automations and find out whether Kody earns a
						place in your setup.
					</p>
					<a href="/signup" mix={css(primaryLinkCss)}>
						Create a free account
					</a>
				</section>

				<section mix={css(proPlanCardCss)}>
					<div>
						<h2 mix={css(planTitleCss)}>Pro</h2>
						<p mix={css(priceCss)}>$5/month</p>
					</div>
					<p mix={css(descriptionCss)}>
						Higher daily volume, more running services, and persistent package
						services.
					</p>
					<a href="/account/billing" mix={css(primaryLinkCss)}>
						Upgrade in Account settings
					</a>
				</section>
			</div>

			<section mix={css(cardCss)}>
				<div>
					<h2 mix={css(planTitleCss)}>Plan limits</h2>
					<p mix={css(descriptionCss)}>
						Every limit is finite. These values come directly from the limits
						Kody enforces.
					</p>
				</div>
				<div mix={css(tableWrapperCss)}>
					<table mix={css(tableCss)}>
						<thead>
							<tr>
								<th scope="col" mix={css(headerCellCss)}>
									Resource
								</th>
								<th scope="col" mix={css(numericHeaderCellCss)}>
									Free
								</th>
								<th scope="col" mix={css(numericHeaderCellCss)}>
									Pro
								</th>
							</tr>
						</thead>
						<tbody>
							{limitRows.map((row) => (
								<tr key={row.key}>
									<th scope="row" mix={css(bodyHeaderCellCss)}>
										{row.label}
									</th>
									<td mix={css(numericCellCss)}>
										{formatLimit(row, planLimits.free)}
									</td>
									<td mix={css(numericCellCss)}>
										{formatLimit(row, planLimits.pro)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(planTitleCss)}>Invite and admin plans</h2>
				<p mix={css(descriptionCss)}>
					Max is a finite, invite-only plan assigned by a Kody administrator; it
					is not available for self-serve purchase. Some partners may also
					receive an admin-assigned Partner plan.
				</p>
			</section>

			<p mix={css({ margin: 0 })}>
				<a href="/privacy" mix={css(mutedLinkCss)}>
					Privacy
				</a>
				{' · '}
				<a href="/terms" mix={css(mutedLinkCss)}>
					Terms
				</a>
				{' · '}
				<a href="/" mix={css(mutedLinkCss)}>
					Back home
				</a>
			</p>
		</section>
	)
}

function formatLimit(row: LimitRow, limits: PlanLimits): string {
	const value = limits[row.key]
	return row.format ? row.format(value) : count.format(value)
}

function formatBytes(value: number): string {
	const mebibyte = 1024 * 1024
	const gibibyte = 1024 * mebibyte
	if (value >= gibibyte) return `${count.format(value / gibibyte)} GiB`
	return `${count.format(value / mebibyte)} MiB`
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '64rem',
	margin: '0 auto',
}

const planGridCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(min(18rem, 100%), 1fr))',
	gap: spacing.lg,
}

const planCardCss = {
	...cardCss,
	alignContent: 'space-between',
}

const proPlanCardCss = {
	...planCardCss,
	borderColor: colors.primary,
	backgroundColor: colors.primarySoftest,
}

const planTitleCss = {
	margin: 0,
	color: colors.text,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
}

const priceCss = {
	margin: `${spacing.xs} 0 0`,
	color: colors.primaryText,
	fontSize: typography.fontSize.xl,
	fontWeight: typography.fontWeight.bold,
}

const tableWrapperCss = {
	overflowX: 'auto' as const,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
}

const tableCss = {
	width: '100%',
	borderCollapse: 'collapse' as const,
	fontSize: typography.fontSize.sm,
}

const headerCellCss = {
	padding: spacing.sm,
	textAlign: 'left' as const,
	color: colors.textMuted,
	borderBottom: `1px solid ${colors.border}`,
}

const numericHeaderCellCss = {
	...headerCellCss,
	textAlign: 'right' as const,
}

const bodyHeaderCellCss = {
	padding: spacing.sm,
	textAlign: 'left' as const,
	color: colors.text,
	fontWeight: typography.fontWeight.normal,
	borderBottom: `1px solid ${colors.border}`,
}

const numericCellCss = {
	padding: spacing.sm,
	textAlign: 'right' as const,
	color: colors.text,
	whiteSpace: 'nowrap' as const,
	borderBottom: `1px solid ${colors.border}`,
}
