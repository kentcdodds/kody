import { type Handle, css } from 'remix/ui'
import { planLimits, type PlanLimits } from '#worker/entitlements/plans.ts'
import { reveal } from '#client/reveal.ts'
import { colors, radius, typography } from '#client/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	getSurfaceCardCss,
	layoutMaxWidths,
	pageHeadCss,
	visuallyHiddenCss,
} from '#client/styles/style-primitives.ts'

/**
 * Pricing page, ported from the redesign prototype (`landing/pricing.html`).
 * Two flat plan panels over a 44rem spec-sheet measure; Pro's green border is
 * the only loud element. Limits render as one honest table grouped under
 * display-face section titles — every value comes from `plans.ts`, never
 * hardcoded here.
 */

type LimitValue = {
	text: string
	muted?: boolean
}

type LimitRow = {
	label: string
	key: keyof PlanLimits
	format?: (value: number) => LimitValue
}

type LimitGroup = {
	title: string
	rows: ReadonlyArray<LimitRow>
}

const count = new Intl.NumberFormat('en-US')

const limitGroups: ReadonlyArray<LimitGroup> = [
	{
		title: 'Packages & jobs',
		rows: [
			{ label: 'Saved packages', key: 'maxSavedPackages' },
			{ label: 'Scheduled jobs', key: 'maxScheduledJobs' },
			{ label: 'Active repo sessions', key: 'maxRepoSessions' },
		],
	},
	{
		title: 'Compute',
		rows: [
			{ label: 'Running package services', key: 'maxPackageServices' },
			{
				label: 'Persistent package services',
				key: 'packageServicePersistentAllowed',
				format: (value) =>
					value === 1
						? { text: 'Included' }
						: { text: 'Not included', muted: true },
			},
			{ label: 'Concurrent workflows', key: 'maxConcurrentWorkflows' },
			{ label: 'Execute calls per day', key: 'maxExecuteCallsPerDay' },
			{ label: 'Outbound fetches per day', key: 'maxOutboundFetchesPerDay' },
		],
	},
	{
		title: 'Email',
		rows: [
			{ label: 'Sends per day', key: 'maxEmailSendsPerDay' },
			{ label: 'Receives per day', key: 'maxEmailReceivesPerDay' },
			{ label: 'Stored messages', key: 'maxStoredEmailMessages' },
			{
				label: 'Maximum message size',
				key: 'maxEmailMessageBytes',
				format: (value) => ({ text: formatLimitBytes(value) }),
			},
		],
	},
	{
		title: 'Storage & secrets',
		rows: [
			{ label: 'Stored secrets', key: 'maxSecrets' },
			{
				label: 'Durable storage',
				key: 'maxStorageBytes',
				format: (value) => ({ text: formatLimitBytes(value) }),
			},
		],
	},
]

export function PricingRoute(_handle: Handle) {
	return () => (
		<section mix={css(pricingCss)}>
			<header mix={css(pageHeadCss)}>
				<h1 data-rise style={{ '--rise': '0' }}>
					Start free.
					<br />
					Pay when it <em>earns it</em>.
				</h1>
				<p data-rise style={{ '--rise': '1' }}>
					Pro is $5 per month when you need more room to run. No metered
					surprises — every limit is finite and published below.
				</p>
			</header>

			<div mix={css(plansCss)}>
				<section
					aria-labelledby="plan-free"
					mix={[css(planPanelCss), reveal()]}
				>
					<h2 id="plan-free" mix={css(planTitleCss)}>
						Free
					</h2>
					<p mix={css(planPriceCss)}>$0</p>
					<p mix={css(planCopyCss)}>
						Enough to build useful automations and find out whether Kody earns a
						place in your setup.
					</p>
					<a href="/signup" mix={css(planPillButtonCss)}>
						Create a free account
					</a>
				</section>

				<section
					aria-labelledby="plan-pro"
					mix={[css(proPlanPanelCss), reveal(90)]}
				>
					<h2 id="plan-pro" mix={css(planTitleCss)}>
						Pro
					</h2>
					<p mix={css(proPlanPriceCss)}>
						$5<small mix={css(planPriceUnitCss)}>/month</small>
					</p>
					<p mix={css(planCopyCss)}>
						Higher daily volume, more running services, and persistent package
						services.
					</p>
					<a href="/account/billing" mix={css(planGhostButtonCss)}>
						Upgrade in Account settings
					</a>
				</section>
			</div>

			<section aria-labelledby="limits-title" mix={css(limitsCss)}>
				<h2 id="limits-title" mix={css(limitsTitleCss)}>
					Every limit is finite
				</h2>
				<p mix={css(limitsLeadCss)}>
					No &ldquo;unlimited&rdquo; asterisks. These values come directly from
					the limits Kody enforces.
				</p>
				<div mix={css(limitsScrollCss)}>
					<table mix={css(limitsTableCss)}>
						<thead>
							<tr>
								<th scope="col">
									<span mix={css(visuallyHiddenCss)}>Resource</span>
								</th>
								<th scope="col">
									<span data-limits-plan>Free</span>
									<span data-limits-price>$0</span>
								</th>
								<th scope="col">
									<span data-limits-plan>Pro</span>
									<span data-limits-price>$5/mo</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{limitGroups.flatMap((group) => [
								<tr key={group.title} data-group>
									<th colspan={3}>{group.title}</th>
								</tr>,
								...group.rows.map((row) => (
									<tr key={row.key}>
										<th scope="row">{row.label}</th>
										{renderLimitCell(row, planLimits.free)}
										{renderLimitCell(row, planLimits.pro)}
									</tr>
								)),
							])}
						</tbody>
					</table>
				</div>
			</section>

			<section aria-label="Invite and admin plans" mix={css(planNoteCss)}>
				<p>
					Max is a finite, invite-only plan assigned by a Kody administrator; it
					is not available for self-serve purchase. Some partners may also
					receive an admin-assigned Partner plan.
				</p>
			</section>
		</section>
	)
}

function renderLimitCell(row: LimitRow, limits: PlanLimits) {
	const value = limits[row.key]
	const cell = row.format ? row.format(value) : { text: count.format(value) }
	return (
		<td>
			{cell.muted ? (
				<span mix={css({ color: colors.textMuted })}>{cell.text}</span>
			) : (
				cell.text
			)}
		</td>
	)
}

/** Exported so tests can derive expectations from `plans.ts` values. */
export function formatLimitBytes(value: number): string {
	const kibibyte = 1024
	const mebibyte = 1024 * kibibyte
	const gibibyte = 1024 * mebibyte
	if (value >= gibibyte) return `${count.format(value / gibibyte)}\u00A0GiB`
	if (value >= mebibyte) return `${count.format(value / mebibyte)}\u00A0MiB`
	return `${count.format(value / kibibyte)}\u00A0KiB`
}

/* ---------- styles ---------- */

const pricingCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding:
		'clamp(3rem, 7vw, 5.5rem) clamp(1.25rem, 4vw, 2.5rem) clamp(4rem, 8vw, 6.5rem)',
}

/* ---------- plan panels ---------- */

const plansCss = {
	width: 'min(100%, 44rem)',
	margin: 'clamp(2.5rem, 6vw, 4rem) auto 0',
	display: 'grid',
	gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
	gap: '1.2rem',
	'@media (max-width: 680px)': {
		gridTemplateColumns: '1fr',
	},
}

const planPanelCss = {
	...getSurfaceCardCss(),
	display: 'flex',
	flexDirection: 'column' as const,
	alignItems: 'flex-start',
	gap: '1rem',
	textAlign: 'left' as const,
	/* Prototype `.plan` sits one step above the base card radius. */
	borderRadius: `calc(${radius.card} + 4px)`,
	padding: 'clamp(1.5rem, 3vw, 2rem)',
	'@media (max-width: 680px)': {
		alignItems: 'stretch',
		textAlign: 'center' as const,
	},
}

/* Pro carries the accent; the border is the only loud thing on the page. */
const proPlanPanelCss = {
	...planPanelCss,
	borderColor: `oklch(from ${colors.primary} l c h / 0.6)`,
}

const planTitleCss = {
	margin: 0,
	fontSize: '1.15rem',
	fontWeight: 720,
	letterSpacing: '-0.012em',
}

const planPriceCss = {
	margin: 0,
	fontFamily: typography.fontFamilyDisplay,
	fontWeight: 760,
	fontSize: 'clamp(2.1rem, 4vw, 2.6rem)',
	lineHeight: 1,
	letterSpacing: '-0.025em',
}

const proPlanPriceCss = {
	...planPriceCss,
	color: colors.primaryText,
}

const planPriceUnitCss = {
	font: `550 1rem/1 ${typography.fontFamilyBody}`,
	color: colors.textMuted,
	letterSpacing: 0,
	marginLeft: '0.2rem',
}

const planCopyCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.98rem',
	maxWidth: '34ch',
	textWrap: 'pretty' as const,
	'@media (max-width: 680px)': {
		marginInline: 'auto',
	},
}

const planButtonSizeCss = {
	marginTop: 'auto',
	fontSize: '0.95rem',
	padding: '0.8rem 1.35rem',
	'@media (max-width: 680px)': {
		marginTop: '0.4rem',
	},
}

const planPillButtonCss = {
	...getPillButtonCss(),
	...planButtonSizeCss,
}

const planGhostButtonCss = {
	...getGhostButtonCss(),
	...planButtonSizeCss,
}

/* ---------- limits table ---------- */

/* One honest table, no marketing checkmarks. Spec-sheet measure — narrow
   enough that the eye never loses the row between label and value. */
const limitsCss = {
	width: 'min(100%, 44rem)',
	margin: 'clamp(3.5rem, 8vw, 5.5rem) auto 0',
}

const limitsTitleCss = {
	margin: 0,
	fontSize: 'clamp(1.5rem, 2.6vw, 1.9rem)',
	fontWeight: 720,
	letterSpacing: '-0.018em',
	textAlign: 'center' as const,
}

const limitsLeadCss = {
	margin: '0.7rem auto 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
	textAlign: 'center' as const,
	maxWidth: '52ch',
	textWrap: 'balance' as const,
}

const limitsScrollCss = {
	marginTop: '1.8rem',
	overflowX: 'auto' as const,
}

const limitsTableCss = {
	width: '100%',
	borderCollapse: 'collapse' as const,
	fontSize: '0.98rem',
	'& th, & td': {
		padding: '0.7rem 0.9rem',
		borderBottom: `1px solid ${colors.border}`,
	},
	/* Labels and values sit flush with the hairline edges; the two plan
	   columns are twins so Free/Pro compare down a steady axis. */
	'& th:first-child, & td:first-child': {
		paddingLeft: '0.2rem',
	},
	'& th:last-child, & td:last-child': {
		paddingRight: '0.2rem',
	},
	'& thead th:not(:first-child), & td': {
		width: '7.5rem',
	},
	'& thead th': {
		font: `600 0.82rem/1.2 ${typography.fontFamilyBody}`,
		letterSpacing: '0.07em',
		textTransform: 'uppercase' as const,
		color: colors.textMuted,
		textAlign: 'left' as const,
		verticalAlign: 'bottom',
		borderBottomColor: colors.textMuted,
	},
	/* Plan header carries its price, so the table answers "which $?" alone. */
	'& [data-limits-plan]': {
		display: 'block',
		color: colors.text,
	},
	'& thead th:last-child [data-limits-plan]': {
		color: colors.primaryText,
	},
	'& [data-limits-price]': {
		display: 'block',
		marginTop: '0.1rem',
		font: `500 0.8rem/1.2 ${typography.fontFamilyBody}`,
		letterSpacing: 0,
		textTransform: 'none' as const,
		color: colors.textMuted,
	},
	/* Group titles are the table's spine: display face, extra air above. */
	'& tr[data-group] th': {
		padding: '2rem 0.2rem 0.55rem',
		font: `700 1.05rem/1.2 ${typography.fontFamilyDisplay}`,
		letterSpacing: '-0.01em',
		textTransform: 'none' as const,
		color: colors.text,
	},
	'& tbody tr:first-child th': {
		paddingTop: '1.1rem',
	},
	'& tbody th': {
		fontWeight: 450,
		color: colors.text,
		textAlign: 'left' as const,
	},
	'& td': {
		textAlign: 'left' as const,
		whiteSpace: 'nowrap' as const,
		fontVariantNumeric: 'tabular-nums',
		color: colors.text,
	},
}

/* ---------- invite/admin note ---------- */

const planNoteCss = {
	width: 'min(100%, 44rem)',
	margin: 'clamp(2.5rem, 5vw, 3.5rem) auto 0',
	textAlign: 'center' as const,
	'& p': {
		margin: 0,
		marginInline: 'auto',
		color: colors.textMuted,
		fontSize: '0.95rem',
		maxWidth: '56ch',
		textWrap: 'pretty' as const,
	},
}
