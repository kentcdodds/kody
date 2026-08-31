import { type RemixNode, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	ActionButtonLoader,
	installProgressWords,
} from '#client/action-button-loader.tsx'
import { routes } from '#universal/routes.ts'
import {
	type AccountPackageDetail,
	type AccountPackagesLoaderData,
} from '#universal/loader-data.ts'
import { AccountPackageOwnerDetails } from '#client/routes/account-package-owner-details.tsx'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	getSurfaceCardCss,
	hoverMq,
	mergeCss,
	pageHeadCss,
	proseCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { type CommunityInstallOutcome } from './community-detail-shared.ts'

export function renderMissingListing(title: string, message: string) {
	return (
		<article mix={css(detailArticleCss)}>
			<a href={routes.community.href()} mix={css(backLinkCss)}>
				← Public packages
			</a>
			<header mix={css(missingHeadCss)}>
				<h1>{title}</h1>
				<p>{message}</p>
			</header>
		</article>
	)
}

export function renderShellStatus(shellStatusMessage: string) {
	return (
		<>
			{/*
			 * A live region only announces text that changes while the region
			 * is already in the accessibility tree, so the announcer stays
			 * mounted for the life of the view and keeps one fixed role.
			 * Swapping two `role="status"` paragraphs announced the failure
			 * inconsistently, because the loading one unmounted as the error
			 * one mounted. Same shape as `renderStatusMessage` in login.tsx.
			 */}
			<p role="status" mix={css(visuallyHiddenCss)}>
				{shellStatusMessage}
			</p>
			{/*
			 * The visible copy is hidden from assistive tech so the same
			 * sentence is not announced twice, and stays out of the flow while
			 * empty so it adds no gap.
			 */}
			<p
				aria-hidden="true"
				hidden={shellStatusMessage ? undefined : true}
				mix={css(shellStatusCss)}
			>
				{shellStatusMessage}
			</p>
		</>
	)
}

export type OwnerPackageSectionProps = {
	ownerPackage: AccountPackageDetail
	username: string
	invocationUrlOrigin: string
	currentHref: string
	lockInFlight: boolean
	ownerDetailsMessage: string | null
	onToggleLock: () => void
	onPackagesPayload: (payload: AccountPackagesLoaderData) => void
}

export function renderOwnerPackageSection(props: OwnerPackageSectionProps) {
	return (
		<section
			aria-labelledby="package-owner-details-title"
			mix={css(detailSectionCss)}
		>
			<h2 id="package-owner-details-title">Package details</h2>
			{props.ownerDetailsMessage ? (
				<p mix={css(errorTextCss)} role="alert">
					{props.ownerDetailsMessage}
				</p>
			) : null}
			<AccountPackageOwnerDetails
				packageDetail={props.ownerPackage}
				username={props.username}
				invocationUrlOrigin={props.invocationUrlOrigin}
				currentHref={props.currentHref}
				lockInFlight={props.lockInFlight}
				onToggleLock={props.onToggleLock}
				onPackagesPayload={props.onPackagesPayload}
			/>
		</section>
	)
}

export type InstallStripProps = {
	installState: 'idle' | 'confirming' | 'submitting' | 'error'
	installMessage: string | null
	installOutcome: CommunityInstallOutcome | null
	starMessage: string | null
	onConfirmInstall: () => void
	onCancelInstall: () => void
}

export function renderInstallStrip(props: InstallStripProps) {
	const installAnnouncement = props.installOutcome
		? props.installOutcome.status === 'installed'
			? `Installed as ${props.installOutcome.targetName}.`
			: `Forked as ${props.installOutcome.targetName}; it needs adaptation before it can run.`
		: ''
	return (
		<div data-testid="community-install" mix={css(installStripCss)}>
			<p role="status" mix={css(visuallyHiddenCss)}>
				{installAnnouncement}
			</p>
			{props.installState === 'submitting' ? (
				<p mix={css(installProgressCss)} role="status">
					<ActionButtonLoader label="Installing" words={installProgressWords} />
				</p>
			) : null}
			{props.installState === 'confirming' ? (
				<div
					mix={css(warningCardCss)}
					data-testid="community-install-warning"
					role="alert"
				>
					<p mix={css({ margin: 0 })}>
						This is someone else&apos;s code. It can run in your account.
						Installing creates a fork you own. It can need adaptation before it
						can run. Confirm to continue.
					</p>
					<div mix={css(buttonRowCss)}>
						<button
							mix={[
								on('click', props.onConfirmInstall),
								css(dangerPillButtonCss),
							]}
						>
							Install
						</button>
						<button
							mix={[
								on('click', props.onCancelInstall),
								css(smallGhostButtonCss),
							]}
						>
							Cancel
						</button>
					</div>
				</div>
			) : null}
			{props.installMessage ? (
				<p mix={css(errorTextCss)} role="alert">
					{props.installMessage}
				</p>
			) : null}
			{props.starMessage ? (
				<p mix={css(errorTextCss)} role="alert">
					{props.starMessage}
				</p>
			) : null}
		</div>
	)
}

export function renderReadmeSection(readme: Array<RemixNode>) {
	return (
		<section aria-labelledby="readme-title" mix={css(readmeSectionCss)}>
			<h2 id="readme-title">README</h2>
			<div data-testid="community-readme" mix={css(readmeProseCss)}>
				{readme}
			</div>
		</section>
	)
}

export type AdminFeatureSectionProps = {
	featured: boolean
	featureState: 'idle' | 'submitting' | 'error'
	featureMessage: string | null
	onToggleFeature: () => void
}

export function renderAdminFeatureSection(props: AdminFeatureSectionProps) {
	return (
		<section
			aria-labelledby="admin-feature-title"
			mix={css(detailSectionCss)}
			data-testid="community-admin-feature"
		>
			<h2 id="admin-feature-title">Admin: onboarding</h2>
			<p>
				{props.featured
					? 'This listing is featured as an onboarding starter package. Removing it hides it from onboarding immediately.'
					: 'Featuring offers this listing during onboarding. Featured is editorial placement, not a safety review.'}
			</p>
			<div mix={css(sectionActionCss)}>
				<button
					disabled={props.featureState === 'submitting'}
					mix={[on('click', props.onToggleFeature), css(smallGhostButtonCss)]}
				>
					{props.featureState === 'submitting'
						? 'Saving…'
						: props.featured
							? 'Remove from onboarding'
							: 'Feature in onboarding'}
				</button>
			</div>
			{props.featureMessage ? (
				<p mix={css(errorTextCss)} role="alert">
					{props.featureMessage}
				</p>
			) : null}
		</section>
	)
}

export type ReportDisclosureProps = {
	loggedIn: boolean
	reportReason: string
	reportState: 'idle' | 'submitting' | 'success' | 'error'
	reportMessage: string | null
	onReasonInput: (value: string) => void
	onSubmitReport: () => void
}

export function renderReportDisclosure(props: ReportDisclosureProps) {
	return (
		<details id="report" mix={css(reportDisclosureCss)}>
			<summary>Report this listing</summary>
			{props.loggedIn ? (
				<div mix={css(reportFormCss)}>
					<label mix={css(reportFieldCss)}>
						<span>Reason</span>
						<textarea
							value={props.reportReason}
							rows={4}
							maxLength={2000}
							placeholder="Describe why this listing should be reviewed."
							mix={[
								css(reportTextareaCss),
								on('input', (event) => {
									props.onReasonInput(
										(event.target as HTMLTextAreaElement).value,
									)
								}),
							]}
						/>
					</label>
					<button
						disabled={
							props.reportState === 'submitting' || !props.reportReason.trim()
						}
						mix={[on('click', props.onSubmitReport), css(smallGhostButtonCss)]}
					>
						{props.reportState === 'submitting'
							? 'Submitting…'
							: 'Submit report'}
					</button>
					{props.reportMessage ? (
						<p
							mix={css(
								props.reportState === 'error' ? errorTextCss : mutedTextCss,
							)}
							role={props.reportState === 'error' ? 'alert' : 'status'}
						>
							{props.reportMessage}
						</p>
					) : null}
				</div>
			) : (
				<p mix={css(reportLoginNoteCss)}>
					<a href="/login" mix={css(inlineLinkCss)}>
						Log in
					</a>{' '}
					to report this listing.
				</p>
			)}
		</details>
	)
}

/* 46rem article measure mirroring the blog post; the route owns its gutters
   (the app shell leaves redesigned marketing paths unpadded). The shirt-
   pattern whisper anchors to the article in rem, not to the short icon-row
   head in percentages, so it renders at the same scale and position as the
   blog post head's fabric. */
export const detailArticleCss = {
	position: 'relative' as const,
	// This borrows `pageHeadCss`'s `zIndex: -1` pseudo without borrowing the
	// rest of it, so it has to carry the `isolate` that scopes that negative
	// z-index. Without it the glow escapes this stacking context and can fall
	// behind an ancestor's background instead of backing the article.
	isolation: 'isolate' as const,
	maxWidth: '46rem',
	marginInline: 'auto',
	width: '100%',
	boxSizing: 'border-box' as const,
	padding:
		'clamp(2.5rem, 6vw, 4rem) clamp(1.25rem, 4vw, 2.5rem) clamp(4rem, 8vw, 6.5rem)',
	'&::before': {
		...pageHeadCss['&::before'],
		inset: 'auto',
		top: '-3rem',
		left: '-30%',
		right: '-30%',
		height: '44rem',
		background: `radial-gradient(ellipse 46% 55% at 70% 22%, oklch(from ${colors.text} l c h / 0.05), transparent 72%)`,
	},
}

const backLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.4rem',
	fontSize: '0.95rem',
	fontWeight: 550,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
}

export const missingHeadCss = {
	marginTop: '1.8rem',
	'& h1': {
		margin: 0,
		fontSize: 'clamp(1.7rem, 4vw, 2.4rem)',
		fontWeight: 760,
		letterSpacing: '-0.024em',
		lineHeight: 1.05,
	},
	'& p': {
		margin: '0.9rem 0 0',
		color: colors.textMuted,
	},
}

const shellStatusCss = {
	margin: 'clamp(1.8rem, 4vw, 2.5rem) 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
}

/* Quiet sections in the `.pkg-fork` voice: display-face h2, muted lede. */
export const detailSectionCss = {
	marginTop: 'clamp(2.4rem, 5vw, 3.2rem)',
	'& h2': {
		margin: 0,
		fontSize: 'clamp(1.4rem, 2.4vw, 1.65rem)',
		fontWeight: 720,
		letterSpacing: '-0.016em',
	},
	'& > p': {
		margin: '0.6rem 0 0',
		color: colors.textMuted,
		fontSize: '0.98rem',
		maxWidth: '56ch',
		textWrap: 'balance' as const,
	},
	// Error lines must out-rank the muted `& > p` default above.
	'& > p[role="alert"]': {
		color: colors.error,
	},
}

const sectionActionCss = {
	marginTop: '1.1rem',
}

const installStripCss = {
	display: 'grid',
	gap: '0.75rem',
}

const installProgressCss = {
	margin: '1.2rem 0 0',
	color: colors.textMuted,
	fontSize: '0.95rem',
}

/* The prototype's smaller `.account-form .button` sizing. */
const smallGhostButtonCss = mergeCss(getGhostButtonCss(), {
	fontSize: '0.95rem',
	padding: '0.75rem 1.3rem',
})

/* The pill grammar in the danger voice for the untrusted-install confirm. */
const dangerPillButtonCss = mergeCss(getPillButtonCss(), {
	backgroundColor: colors.danger,
	color: colors.onDanger,
	[hoverMq]: {
		'&:not(:disabled):hover': {
			backgroundColor: colors.dangerHover,
			color: colors.onDanger,
			boxShadow: `0 6px 20px -8px oklch(from ${colors.danger} l c h / 0.6)`,
		},
	},
})

const warningCardCss = mergeCss(getSurfaceCardCss(), {
	marginTop: '1.2rem',
	borderColor: colors.danger,
	padding: '1.1rem 1.3rem',
	display: 'grid',
	gap: '0.9rem',
	'& p': {
		fontSize: '0.95rem',
	},
})

const buttonRowCss = {
	display: 'flex',
	gap: '0.5rem',
	flexWrap: 'wrap' as const,
}

export const inlineLinkCss = {
	color: colors.primaryText,
	textDecorationThickness: '1.5px',
	textUnderlineOffset: '3px',
}

export const errorTextCss = {
	margin: '0.8rem 0 0',
	color: colors.error,
	fontSize: '0.95rem',
}

const mutedTextCss = {
	margin: '0.8rem 0 0',
	color: colors.textMuted,
	fontSize: '0.95rem',
}

/* README as real prose (no scroll box), h3 subheads per DESIGN.md. */
const readmeSectionCss = {
	marginTop: 'clamp(2.4rem, 5vw, 3.2rem)',
	'& > h2': {
		margin: 0,
		fontSize: 'clamp(1.4rem, 2.4vw, 1.65rem)',
		fontWeight: 720,
		letterSpacing: '-0.016em',
		paddingBottom: '0.9rem',
		borderBottom: `1px solid ${colors.border}`,
	},
}

const readmeProseCss = mergeCss(proseCss, {
	marginTop: '1.4rem',
	'& h3': {
		margin: '1.8rem 0 0',
		fontSize: '1.15rem',
		fontWeight: 720,
		letterSpacing: '-0.01em',
	},
})

/* "Report this listing" tucked in a details disclosure. */
const reportDisclosureCss = {
	marginTop: 'clamp(2.4rem, 5vw, 3.2rem)',
	'& summary': {
		cursor: 'pointer',
		fontWeight: 600,
		color: colors.textMuted,
		width: 'fit-content',
		transition: `color ${transitions.fast}`,
	},
	'& summary:hover': {
		color: colors.text,
	},
	'&[open] summary': {
		color: colors.text,
	},
	'& > :not(summary)': {
		'@media (prefers-reduced-motion: no-preference)': {
			transition: `opacity 200ms ${transitions.easeOut}, translate 200ms ${transitions.easeOut}`,
		},
		'@starting-style': {
			opacity: 0,
			translate: '0 4px',
		},
	},
}

const reportFormCss = {
	marginTop: '1.3rem',
	maxWidth: '34rem',
	display: 'grid',
	gap: '1rem',
	justifyItems: 'start',
}

const reportFieldCss = {
	width: '100%',
	display: 'grid',
	gap: '0.45rem',
	'& > span': {
		fontSize: '0.92rem',
		fontWeight: 600,
		color: colors.text,
	},
}

const reportTextareaCss = {
	font: `400 1rem/1.5 ${typography.fontFamilyBody}`,
	color: colors.text,
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: '12px',
	padding: '0.85rem 1.05rem',
	width: '100%',
	minHeight: '6.5rem',
	resize: 'vertical' as const,
	boxSizing: 'border-box' as const,
	'&::placeholder': {
		color: colors.textMuted,
		opacity: 1,
	},
	'&:focus': {
		outline: 'none',
		borderColor: colors.primary,
		boxShadow: `0 0 0 3px oklch(from ${colors.primary} l c h / 0.25)`,
	},
}

const reportLoginNoteCss = {
	margin: '1.3rem 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
}
