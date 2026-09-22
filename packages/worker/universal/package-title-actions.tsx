/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type RemixNode, css } from 'remix/ui'
import { type ViewerListingInstall } from '#universal/community-public-types.ts'
import {
	getCommunityPackageHrefFromName,
	isOfficialCommunityListing,
} from '#universal/community-links.ts'
import {
	FORK_OUTDATED_COPY_TOOLTIP,
	copyPromptTooltipCss,
} from '#universal/fork-outdated-copy-button.tsx'
import { renderIcon, type IconName } from '#universal/icon.tsx'
import { routes } from '#universal/routes.ts'
import {
	inlineSpinnerCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

export const PACKAGE_TITLE_STATUS_SELECTOR = '[data-package-title-status]'
const OTHER_ACCOUNT_FORK_TOOLTIP =
	'This listing is from another account. Verify it before using.'
const FORK_TITLE_TOOLTIP = 'Fork'
const OPEN_FORK_TOOLTIP = 'Open fork'
const COPY_SETUP_PROMPT_TOOLTIP = 'Copy setup prompt'

const titleIconSize = '0.95em'
const statusTooltipId = 'package-title-status-tooltip'
const copyTooltipId = 'package-title-copy-tooltip'

type PackageTitleActionsInput = {
	viewerIsOwner: boolean
	loggedIn: boolean
	returnTo: string
	listingId: string
	listingName: string
	ownerUsername: string
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
			getCommunityPackageHrefFromName(install.targetName) ??
			routes.accountPackages.href()
		return renderIconControl({
			href,
			status: 'open',
			icon: 'arrow-up-right',
			label: OPEN_FORK_TOOLTIP,
			tooltip: OPEN_FORK_TOOLTIP,
			testId: 'package-title-status',
		})
	}
	const official = isOfficialCommunityListing({
		name: input.listingName,
		ownerUsername: input.ownerUsername,
	})
	const loginHref = routes.login.href(null, {
		searchParams: { redirectTo: input.returnTo || routes.community.href() },
	})
	if (official) {
		return renderInstallControl({
			kind: 'fork',
			icon: 'git-fork',
			label: FORK_TITLE_TOOLTIP,
			tooltip: FORK_TITLE_TOOLTIP,
			loggedIn: input.loggedIn,
			loginHref,
			official: true,
			trusted: input.trusted,
			listingId: input.listingId,
		})
	}
	return renderInstallControl({
		kind: 'verify',
		icon: 'two-checkmarks',
		label: OTHER_ACCOUNT_FORK_TOOLTIP,
		tooltip: OTHER_ACCOUNT_FORK_TOOLTIP,
		loggedIn: input.loggedIn,
		loginHref,
		official: false,
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
	kind: 'fork' | 'verify'
	icon: IconName
	label: string
	tooltip: string
	loggedIn: boolean
	loginHref: string
	official: boolean
	trusted: boolean
	listingId: string
}) {
	const shared = {
		'data-testid': 'community-detail-install',
		'data-package-title-status': input.kind,
		'data-package-title-idle': input.kind,
		'data-package-title-listing': input.listingId,
		'data-title-idle-label': input.label,
		'data-title-idle-tooltip': input.tooltip,
		'data-community-install': '',
		'data-official': input.official ? 'true' : 'false',
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
			<a href={input.loginHref} {...shared} mix={css(titleActionCss)}>
				{children}
			</a>
		)
	}
	return (
		<button type="button" {...shared} mix={css(titleActionCss)}>
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
			<span id={tooltipId} role="tooltip" aria-hidden="true">
				{input.tooltip}
			</span>
		</>
	)
	const mix = css(titleActionCss)
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
	gap: '0.35rem',
	flex: 'none',
}

const titleActionCss = {
	...copyPromptTooltipCss,
	position: 'relative' as const,
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flex: 'none',
	padding: 0,
	margin: 0,
	border: 'none',
	background: 'none',
	color: colors.textMuted,
	lineHeight: 0,
	cursor: 'pointer',
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
		borderRadius: '2px',
	},
}

const titleSpinnerCss = {
	...inlineSpinnerCss,
	display: 'inline-block',
	width: titleIconSize,
	height: titleIconSize,
	border: `1.5px solid ${colors.border}`,
	borderTopColor: colors.primary,
}
