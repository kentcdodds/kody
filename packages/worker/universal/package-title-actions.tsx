/** @jsxImportSource remix/component */
/** @jsxRuntime automatic */
import { type RemixNode, css } from 'remix/component'
import { type ViewerListingInstall } from '#universal/community-public-types.ts'
import { getCommunityPackageHrefFromName } from '#universal/community-links.ts'
import {
	FORK_OUTDATED_COPY_TOOLTIP,
	copyPromptTooltipCss,
} from '#universal/fork-outdated-copy-button.tsx'
import { renderIcon, type IconName } from '#universal/icon.tsx'
import { routes } from '#universal/routes.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	hoverMq,
	inlineSpinnerCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { colors, typography } from '#universal/styles/tokens.ts'

export const PACKAGE_TITLE_STATUS_SELECTOR = '[data-package-title-status]'
const OTHER_ACCOUNT_FORK_TOOLTIP =
	'This was built by another user. Verify it before using. Click again to confirm fork.'
const FORK_TITLE_TOOLTIP = 'Fork'
const OPEN_FORK_TOOLTIP = 'Open fork'
const COPY_SETUP_PROMPT_TOOLTIP = 'Copy setup prompt'

const titleIconSize = '1.15em'
const statusTooltipId = 'package-title-status-tooltip'
const copyTooltipId = 'package-title-copy-tooltip'

type PackageTitleActionsInput = {
	viewerIsOwner: boolean
	loggedIn: boolean
	returnTo: string
	listingId: string
	trusted: boolean
	viewerInstall: ViewerListingInstall | null
}

/**
 * One status control beside the package name, plus a clipboard when a setup
 * prompt exists. Steady states are static frame HTML; the install spinner is
 * revealed on the same fork/verify control.
 */
export function renderPackageTitleActions(input: PackageTitleActionsInput) {
	if (input.viewerIsOwner) return null
	const status = renderStatusControl(input)
	const clipboard = renderSetupPromptControl(input.viewerInstall)
	if (!status && !clipboard) return null
	return (
		<span data-testid="package-title-actions" mix={css(titleActionsCss)}>
			{status}
			{clipboard}
		</span>
	)
}

function renderStatusControl(input: PackageTitleActionsInput) {
	const install = input.viewerInstall
	if (install?.listingAhead && install.listingAheadPrompt) {
		return renderOutdatedControl(install)
	}
	if (install) {
		const href =
			getCommunityPackageHrefFromName(install.targetName) ?? '/account/packages'
		return renderIconControl({
			href,
			status: 'open',
			icon: 'arrow-up-right',
			label: OPEN_FORK_TOOLTIP,
			tooltip: OPEN_FORK_TOOLTIP,
			testId: 'package-title-status',
		})
	}
	const loginHref = routes.login.href(null, {
		searchParams: { redirectTo: input.returnTo || routes.community.href() },
	})
	return renderInstallControl({
		icon: 'git-fork',
		label: FORK_TITLE_TOOLTIP,
		tooltip: OTHER_ACCOUNT_FORK_TOOLTIP,
		loggedIn: input.loggedIn,
		loginHref,
		trusted: input.trusted,
		listingId: input.listingId,
	})
}

function renderSetupPromptControl(
	install: ViewerListingInstall | null,
): RemixNode {
	if (!install || install.listingAhead) return null
	if (install.status !== 'adaptation_required') return null
	const prompt = install.agentPrompt.trim()
	if (!prompt) return null
	return renderIconControl({
		status: null,
		icon: 'clipboard',
		label: COPY_SETUP_PROMPT_TOOLTIP,
		tooltip: COPY_SETUP_PROMPT_TOOLTIP,
		testId: 'package-title-copy-setup',
		copyText: prompt,
	})
}

function renderOutdatedControl(install: ViewerListingInstall) {
	const prompt = install.listingAheadPrompt ?? ''
	return renderIconControl({
		href: install.listingDiffHref,
		status: 'outdated',
		icon: 'link-break',
		label: 'Fork outdated',
		tooltip: FORK_OUTDATED_COPY_TOOLTIP,
		testId: 'package-title-status',
		copyText: prompt,
		outdated: true,
	})
}

function renderInstallControl(input: {
	icon: IconName
	label: string
	tooltip: string
	loggedIn: boolean
	loginHref: string
	trusted: boolean
	listingId: string
}) {
	const shared = {
		'data-testid': 'community-detail-install',
		'data-package-title-status': 'verify',
		'data-package-title-idle': 'verify',
		'data-package-title-listing': input.listingId,
		'data-title-idle-label': input.label,
		'data-title-idle-tooltip': input.tooltip,
		'data-community-install': '',
		'data-trusted': input.trusted ? 'true' : 'false',
		'aria-label': input.label,
		'aria-describedby': statusTooltipId,
	}
	const children = (
		<>
			<span data-title-status-icon>
				{renderIcon(input.icon, { size: titleIconSize })}
			</span>
			<span data-title-status-spinner hidden mix={css(titleSpinnerCss)} />
			<span data-title-status-label>{input.label}</span>
			<span
				id={statusTooltipId}
				role="tooltip"
				data-title-status-tooltip
				aria-hidden="true"
			>
				{input.tooltip}
			</span>
			<span
				data-title-status-live
				aria-live="polite"
				mix={css(visuallyHiddenCss)}
			/>
		</>
	)
	if (!input.loggedIn) {
		return (
			<a href={input.loginHref} {...shared} mix={css(packageActionPrimaryCss)}>
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

function renderIconControl(input: {
	href?: string | null
	status: 'open' | 'outdated' | null
	icon: IconName
	label: string
	tooltip: string
	testId: string
	copyText?: string
	outdated?: boolean
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
		'aria-label': input.label,
		'aria-describedby': tooltipId,
		...statusAttrs,
		...copyAttrs,
	}
	const children = (
		<>
			{renderIcon(input.icon, { size: titleIconSize })}
			<span>{input.label}</span>
			<span id={tooltipId} role="tooltip" aria-hidden="true">
				{input.tooltip}
			</span>
		</>
	)
	const mix = css(packageActionSecondaryCss)
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

const titleActionsCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.5rem',
	flex: 'none',
}

/**
 * Repo-page actions reuse the account-area pill vocabulary at a tab-row
 * height: one filled pill for the action the page exists for, ghost pills
 * for everything else. Topic tags and status badges never use these.
 */
function compactActionCss<
	T extends ReturnType<typeof getPillButtonCss | typeof getGhostButtonCss>,
>(base: T) {
	return {
		...base,
		...copyPromptTooltipCss,
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

export const packageActionPrimaryCss = compactActionCss(
	getPillButtonCss({ size: 'sm' }),
)
export const packageActionSecondaryCss = compactActionCss(
	getGhostButtonCss({ size: 'sm' }),
)

const titleSpinnerCss = {
	...inlineSpinnerCss,
	display: 'inline-block',
	width: titleIconSize,
	height: titleIconSize,
	border: '1.5px solid oklch(from currentColor l c h / 0.35)',
	borderTopColor: 'currentColor',
	// `inline-block` would otherwise beat the `hidden` attribute in idle.
	'&[hidden]': {
		display: 'none',
	},
}
