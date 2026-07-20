import { type Handle, css } from 'remix/ui'
import * as popover from 'remix/ui/popover'
import { routes } from '#app/routes.ts'
import { type OnboardingFeaturedListing } from '#app/community-public-types.ts'
import { CommunityListingIcon } from '#app/community-listing-icon.tsx'
import { writeClipboardText } from '#client/clipboard.ts'
import { on } from '#client/event-mixin.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#client/styles/tokens.ts'
import {
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	insetCardCss,
} from '#client/styles/style-primitives.ts'

type OnboardingStarterCardProps = {
	listing: OnboardingFeaturedListing
	loggedIn: boolean
}

type InstallApiPayload = {
	ok: boolean
	status?: 'installed' | 'adaptation_required'
	targetName?: string
	agentPrompt?: string
	error?: string
}

type CardPhase = 'idle' | 'installing' | 'ready' | 'error'

const copyPromptTooltip =
	'Copies a short prompt you can paste into your agent to finish setup for this package.'

/**
 * Featured onboarding starter: install in place, then copy the agent setup
 * prompt without leaving /onboarding.
 */
export function OnboardingStarterCard(
	handle: Handle<OnboardingStarterCardProps>,
) {
	let phase: CardPhase = 'idle'
	let agentPrompt: string | null = null
	let statusMessage: string | null = null
	let errorMessage: string | null = null
	let copyState: 'idle' | 'copied' | 'error' = 'idle'
	let copyResetTimerId: ReturnType<typeof setTimeout> | null = null
	let tooltipOpen = false

	function openTooltip() {
		if (!agentPrompt) return
		tooltipOpen = true
		handle.update()
	}

	function closeTooltip() {
		tooltipOpen = false
		handle.update()
	}

	async function submitInstall() {
		const { listing, loggedIn } = handle.props
		if (!loggedIn) {
			window.location.assign(
				`/login?redirectTo=${encodeURIComponent('/onboarding')}`,
			)
			return
		}
		if (phase === 'installing') return

		phase = 'installing'
		errorMessage = null
		statusMessage = null
		handle.update()

		try {
			const response = await fetch(
				routes.communityInstallApiPost.href({ listingId: listing.id }),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({}),
				},
			)
			if (response.status === 401) {
				window.location.assign(
					`/login?redirectTo=${encodeURIComponent('/onboarding')}`,
				)
				return
			}
			const payload = await readJson<InstallApiPayload>(response)
			if (
				!response.ok ||
				!payload?.ok ||
				!payload.status ||
				!payload.targetName ||
				!payload.agentPrompt
			) {
				throw new Error(
					payload?.error ?? 'Unable to install this community package.',
				)
			}
			agentPrompt = payload.agentPrompt
			statusMessage =
				payload.status === 'installed'
					? `Installed as ${payload.targetName}.`
					: `Forked as ${payload.targetName}; needs adaptation before it can run.`
			phase = 'ready'
			handle.update()
		} catch (error) {
			phase = 'error'
			errorMessage =
				error instanceof Error
					? error.message
					: 'Unable to install this community package.'
			handle.update()
		}
	}

	async function copyPrompt() {
		if (!agentPrompt) return
		try {
			await writeClipboardText(agentPrompt)
			copyState = 'copied'
		} catch {
			copyState = 'error'
		}
		handle.update()
		if (copyResetTimerId != null) clearTimeout(copyResetTimerId)
		copyResetTimerId = setTimeout(() => {
			copyResetTimerId = null
			if (handle.signal.aborted) return
			copyState = 'idle'
			handle.update()
		}, 2000)
	}

	return () => {
		const { listing } = handle.props
		const detailHref = routes.communityDetail.href({ listingId: listing.id })

		return (
			<li>
				<div
					mix={css(starterCardCss)}
					data-testid={`onboarding-starter-${listing.id}`}
				>
					<a href={detailHref} mix={css(starterCardLinkCss)}>
						<CommunityListingIcon listing={listing} size="card" />
						<span mix={css(starterCardBodyCss)}>
							<span mix={css(starterCardTitleCss)}>{listing.name}</span>
							<span mix={css(starterCardDescriptionCss)}>
								{listing.description}
							</span>
						</span>
					</a>
					<div mix={css(starterCardActionsCss)}>
						{phase === 'ready' && agentPrompt ? (
							<popover.Context>
								<button
									type="button"
									aria-describedby={`onboarding-starter-prompt-tip-${listing.id}`}
									mix={[
										css(getSecondaryButtonCss()),
										popover.anchor({ placement: 'top' }),
										popover.focusOnHide(),
										on('click', () => void copyPrompt()),
										on('pointerenter', openTooltip),
										on('pointerleave', closeTooltip),
										on('focus', openTooltip),
										on('blur', closeTooltip),
									]}
									data-testid={`onboarding-starter-copy-${listing.id}`}
								>
									{copyState === 'copied'
										? 'Copied'
										: copyState === 'error'
											? 'Copy failed'
											: 'Copy prompt'}
								</button>
								<div
									id={`onboarding-starter-prompt-tip-${listing.id}`}
									role="tooltip"
									mix={[
										css(tooltipSurfaceCss),
										popover.surface({
											open: tooltipOpen,
											closeOnAnchorClick: false,
											onHide() {
												closeTooltip()
											},
										}),
									]}
								>
									{copyPromptTooltip}
								</div>
							</popover.Context>
						) : (
							<button
								type="button"
								disabled={phase === 'installing'}
								mix={[
									css(getPrimaryButtonCss()),
									on('click', () => void submitInstall()),
								]}
								data-testid={`onboarding-starter-install-${listing.id}`}
							>
								{phase === 'installing' ? 'Installing' : 'Install'}
							</button>
						)}
					</div>
				</div>
				{statusMessage ? (
					<p
						mix={css(statusCss)}
						role="status"
						data-testid={`onboarding-starter-status-${listing.id}`}
					>
						{statusMessage}
					</p>
				) : null}
				{errorMessage ? (
					<p
						mix={css(errorCss)}
						role="alert"
						data-testid={`onboarding-starter-error-${listing.id}`}
					>
						{errorMessage}
					</p>
				) : null}
			</li>
		)
	}
}

const starterCardCss = {
	...insetCardCss,
	display: 'flex',
	alignItems: 'center',
	gap: '0.75rem',
	color: colors.text,
}

const starterCardLinkCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.75rem',
	flex: 1,
	minWidth: 0,
	textDecoration: 'none',
	color: 'inherit',
	'&:hover span:first-of-type': {
		color: colors.primary,
	},
}

const starterCardBodyCss = {
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.25rem',
	minWidth: 0,
}

const starterCardTitleCss = {
	fontWeight: typography.fontWeight.semibold,
	color: colors.primaryText,
	overflowWrap: 'anywhere' as const,
}

const starterCardDescriptionCss = {
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const starterCardActionsCss = {
	flexShrink: 0,
}

const statusCss = {
	margin: '0.35rem 0 0',
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const errorCss = {
	margin: '0.35rem 0 0',
	color: colors.error,
	fontSize: typography.fontSize.sm,
}

const tooltipSurfaceCss = {
	maxWidth: '16rem',
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.md,
	backgroundColor: colors.surface,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.4,
	boxShadow: shadows.md,
	border: `1px solid ${colors.border}`,
}
