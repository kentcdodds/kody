/** @jsxImportSource remix/component */
/** @jsxRuntime automatic */
import { type RemixNode, css } from 'remix/component'
import { type ViewerListingInstall } from '#universal/community-public-types.ts'
import { getCommunityPackageHrefFromName } from '#universal/community-links.ts'
import {
	FORK_AHEAD_TOOLTIP,
	FORK_OUTDATED_COPY_TOOLTIP,
	copyPromptTooltipCss,
} from '#universal/fork-outdated-copy-button.tsx'
import { renderIcon, type IconName } from '#universal/icon.tsx'
import {
	getGhostButtonCss,
	getPillButtonCss,
	hoverMq,
	inlineSpinnerCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { colors, mq, typography } from '#universal/styles/tokens.ts'

export const PACKAGE_TITLE_STATUS_SELECTOR = '[data-package-title-status]'
const OTHER_ACCOUNT_FORK_TOOLTIP =
	'This was built by another user. Verify it before using. Click again to confirm fork.'
const FORK_LABEL = 'Fork'
const OPEN_FORK_LABEL = 'Open fork'
const COPY_SETUP_PROMPT_LABEL = 'Copy setup prompt'

const actionIconSize = '1.1em'
const statusTooltipId = 'package-title-status-tooltip'
const copyTooltipId = 'package-title-copy-tooltip'

type PackageRepoForkAction = {
	listingId: string
	trusted: boolean
	loggedIn: boolean
	loginHref: string
	viewerInstall: ViewerListingInstall | null
}

/**
 * Everything the repository action group can offer on any tab (Repo, Files,
 * Settings). Built on the server from the package page so each tab renders
 * the same group; null fields render nothing.
 */
export type PackageRepoActions = {
	/** Visitors on a listed package. Owners never fork their own listing. */
	fork: PackageRepoForkAction | null
	/** Owner: default-branch HEAD is ahead of the last publish. */
	publishHref: string | null
	/** Owner: the package declares an app. */
	packageAppHref: string | null
}

function hasPackageRepoActions(actions: PackageRepoActions | null) {
	if (!actions) return false
	return Boolean(actions.fork || actions.publishHref || actions.packageAppHref)
}

/**
 * The action group's contents, in visual order: outlined maintenance and
 * secondary actions first, then the one filled action the viewer came for
 * (Fork / Open fork for visitors, Open app for owners). Statuses that are not
 * actions (Featured, private, package marks) stay out of this group.
 */
export function renderPackageRepoActions(
	actions: PackageRepoActions | null,
): RemixNode {
	if (!actions || !hasPackageRepoActions(actions)) return null
	const install = actions.fork?.viewerInstall ?? null
	const publishIsPrimary = Boolean(
		actions.publishHref && !actions.packageAppHref && !actions.fork,
	)
	return (
		<>
			{actions.publishHref ? (
				<a
					href={actions.publishHref}
					data-testid="community-detail-source-ahead-badge"
					aria-describedby="package-repo-publish-tooltip"
					mix={css(
						publishIsPrimary
							? packageActionPrimaryCss
							: packageActionSecondaryCss,
					)}
				>
					{renderIcon('arrow-up-right', { size: actionIconSize })}
					<span>Publish changes</span>
					<span
						id="package-repo-publish-tooltip"
						role="tooltip"
						aria-hidden="true"
					>
						Default-branch HEAD is newer than the live version. Review the
						changes, then publish them.
					</span>
				</a>
			) : null}
			{actions.fork ? renderSetupPromptControl(install) : null}
			{install?.forkAhead && install.listingDiffHref ? (
				<a
					href={install.listingDiffHref}
					data-testid="community-detail-listing-fork-ahead-badge"
					aria-describedby="package-repo-fork-ahead-tooltip"
					mix={css(packageActionSecondaryCss)}
				>
					{renderIcon('git-fork', { size: actionIconSize })}
					<span>Fork ahead</span>
					<span
						id="package-repo-fork-ahead-tooltip"
						role="tooltip"
						aria-hidden="true"
					>
						{FORK_AHEAD_TOOLTIP}
					</span>
				</a>
			) : null}
			{actions.fork ? renderStatusControl(actions.fork) : null}
			{actions.packageAppHref ? (
				<a
					href={actions.packageAppHref}
					data-testid="open-package-app"
					data-rmx-document
					mix={css(packageActionPrimaryCss)}
				>
					{renderIcon('share', { size: actionIconSize })}
					<span>Open app</span>
				</a>
			) : null}
		</>
	)
}

function renderStatusControl(fork: PackageRepoForkAction) {
	const install = fork.viewerInstall
	if (install?.listingAhead && install.listingAheadPrompt) {
		return renderLabeledControl({
			href: install.listingDiffHref,
			status: 'outdated',
			icon: 'link-break',
			label: 'Fork outdated',
			tooltip: FORK_OUTDATED_COPY_TOOLTIP,
			testId: 'package-title-status',
			copyText: install.listingAheadPrompt,
			outdated: true,
			primary: false,
		})
	}
	if (install) {
		return renderLabeledControl({
			href:
				getCommunityPackageHrefFromName(install.targetName) ??
				'/account/packages',
			status: 'open',
			icon: 'arrow-up-right',
			label: OPEN_FORK_LABEL,
			tooltip: `Open your fork, ${install.targetName}.`,
			testId: 'package-title-status',
			primary: true,
		})
	}
	return renderInstallControl(fork)
}

function renderSetupPromptControl(
	install: ViewerListingInstall | null,
): RemixNode {
	if (!install || install.listingAhead) return null
	if (install.status !== 'adaptation_required') return null
	const prompt = install.agentPrompt.trim()
	if (!prompt) return null
	return renderLabeledControl({
		status: null,
		icon: 'clipboard',
		label: COPY_SETUP_PROMPT_LABEL,
		tooltip: 'Copy the prompt that adapts your fork to your account.',
		testId: 'package-title-copy-setup',
		copyText: prompt,
		primary: false,
	})
}

function renderInstallControl(fork: PackageRepoForkAction) {
	const shared = {
		'data-testid': 'community-detail-install',
		'data-package-title-status': 'verify',
		'data-package-title-idle': 'verify',
		'data-package-title-listing': fork.listingId,
		'data-title-idle-label': FORK_LABEL,
		'data-title-idle-tooltip': OTHER_ACCOUNT_FORK_TOOLTIP,
		'data-community-install': '',
		'data-trusted': fork.trusted ? 'true' : 'false',
		'aria-label': FORK_LABEL,
		'aria-describedby': statusTooltipId,
	}
	const children = (
		<>
			<span data-title-status-icon>
				{renderIcon('git-fork', { size: actionIconSize })}
			</span>
			<span data-title-status-spinner hidden mix={css(spinnerCss)} />
			<span data-title-status-label>{FORK_LABEL}</span>
			<span
				id={statusTooltipId}
				role="tooltip"
				data-title-status-tooltip
				aria-hidden="true"
			>
				{OTHER_ACCOUNT_FORK_TOOLTIP}
			</span>
			<span
				data-title-status-live
				aria-live="polite"
				mix={css(visuallyHiddenCss)}
			/>
		</>
	)
	if (!fork.loggedIn) {
		return (
			<a href={fork.loginHref} {...shared} mix={css(packageActionPrimaryCss)}>
				{children}
			</a>
		)
	}
	return (
		<button type="button" {...shared} mix={css(packageActionPrimaryCss)}>
			{children}
		</button>
	)
}

function renderLabeledControl(input: {
	href?: string | null
	status: 'open' | 'outdated' | null
	icon: IconName
	label: string
	tooltip: string
	testId: string
	copyText?: string
	outdated?: boolean
	primary: boolean
}) {
	const tooltipId = input.copyText ? copyTooltipId : statusTooltipId
	const copyAttrs = input.copyText
		? {
				'data-copy-prompt': '',
				'data-copy-text': input.copyText,
				'data-copy-tooltip': input.tooltip,
				...(input.outdated ? { 'data-fork-outdated-copy': '' } : {}),
			}
		: {}
	const statusAttrs = input.status
		? { 'data-package-title-status': input.status }
		: {}
	const shared = {
		'data-testid': input.testId,
		'aria-describedby': tooltipId,
		...statusAttrs,
		...copyAttrs,
	}
	const children = (
		<>
			{renderIcon(input.icon, { size: actionIconSize })}
			<span>{input.label}</span>
			<span id={tooltipId} role="tooltip" aria-hidden="true">
				{input.tooltip}
			</span>
		</>
	)
	const mix = css(
		input.primary ? packageActionPrimaryCss : packageActionSecondaryCss,
	)
	if (input.href) {
		return (
			<a href={input.href} {...shared} mix={mix}>
				{children}
			</a>
		)
	}
	return (
		<button type="button" {...shared} mix={mix}>
			{children}
		</button>
	)
}

/**
 * The group sits at the right edge of the tab row on desktop, so tooltips
 * open leftward from the control's right edge. On mobile the group starts at
 * the left gutter, so they open rightward instead. Centered tooltips ran off
 * the viewport in both places.
 */
const edgeAnchoredTooltipCss = {
	'& [role="tooltip"]': {
		...copyPromptTooltipCss['& [role="tooltip"]'],
		left: 'auto',
		right: 0,
		transform: 'none',
		[mq.mobile]: {
			left: 0,
			right: 'auto',
		},
	},
	'& [role="tooltip"]::after': {
		...copyPromptTooltipCss['& [role="tooltip"]::after'],
		left: 'auto',
		right: '1rem',
		transform: 'none',
		[mq.mobile]: {
			left: '1rem',
			right: 'auto',
		},
	},
}

/**
 * Repo actions reuse the account-area pill vocabulary at tab-row height: one
 * filled pill for the action the page exists for, ghost pills for everything
 * else. Topic tags and status badges never use these.
 */
function compactActionCss<
	T extends ReturnType<typeof getPillButtonCss | typeof getGhostButtonCss>,
>(base: T) {
	return {
		...base,
		...copyPromptTooltipCss,
		...edgeAnchoredTooltipCss,
		position: 'relative' as const,
		padding: '0.5rem 0.95rem',
		font: `650 0.875rem/1 ${typography.fontFamilyDisplay}`,
		'&:focus-visible': {
			outline: `2px solid ${colors.primary}`,
			outlineOffset: '2px',
		},
		[hoverMq]: {
			...base[hoverMq],
			...copyPromptTooltipCss[hoverMq],
		},
	}
}

const packageActionPrimaryCss = compactActionCss(
	getPillButtonCss({ size: 'sm' }),
)
const packageActionSecondaryCss = compactActionCss(
	getGhostButtonCss({ size: 'sm' }),
)

const spinnerCss = {
	...inlineSpinnerCss,
	display: 'inline-block',
	width: actionIconSize,
	height: actionIconSize,
	border: '1.5px solid oklch(from currentColor l c h / 0.35)',
	borderTopColor: 'currentColor',
	// `inline-block` would otherwise beat the `hidden` attribute in idle.
	'&[hidden]': {
		display: 'none',
	},
}
