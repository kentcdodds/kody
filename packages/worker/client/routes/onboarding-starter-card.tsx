import { type Handle, css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'
import { CommunityListingIcon } from '#universal/community-listing-icon.tsx'
import { writeClipboardText } from '#client/clipboard.ts'
import { on } from '#client/event-mixin.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	hoverMq,
} from '#universal/styles/style-primitives.ts'

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
 * Featured onboarding starter, ported from the prototype's `.starter-card`:
 * compact centered card on the page ground with the package icon in a rounded
 * well, in-place install, then copy the agent setup prompt without leaving
 * /onboarding.
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

	async function copyPrompt(prompt: string) {
		try {
			await writeClipboardText(prompt)
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
		const existingInstall = listing.viewerInstall ?? null
		const readyPrompt = agentPrompt ?? existingInstall?.agentPrompt ?? null
		const readyStatus =
			statusMessage ??
			(existingInstall
				? existingInstall.status === 'installed'
					? `Installed as ${existingInstall.targetName}.`
					: `Forked as ${existingInstall.targetName}; needs adaptation before it can run.`
				: null)
		const showCopyPrompt = readyPrompt != null

		return (
			<li
				mix={css(starterCardCss)}
				data-testid={`onboarding-starter-${listing.id}`}
			>
				<a
					href={detailHref}
					target="_blank"
					rel="noreferrer noopener"
					mix={css(starterCardLinkCss)}
				>
					<CommunityListingIcon listing={listing} size="starter" />
					<strong mix={css(starterCardNameCss)}>{listing.name}</strong>
					<span mix={css(starterCardDescriptionCss)}>
						{listing.description}
					</span>
				</a>
				{showCopyPrompt ? (
					<button
						type="button"
						aria-describedby={`onboarding-starter-prompt-tip-${listing.id}`}
						mix={[
							css(copyPromptButtonCss),
							on('click', () => void copyPrompt(readyPrompt)),
						]}
						data-testid={`onboarding-starter-copy-${listing.id}`}
					>
						{copyState === 'copied'
							? 'Copied'
							: copyState === 'error'
								? 'Copy failed'
								: 'Copy prompt'}
						<span
							id={`onboarding-starter-prompt-tip-${listing.id}`}
							role="tooltip"
						>
							{copyPromptTooltip}
						</span>
					</button>
				) : (
					<button
						type="button"
						disabled={phase === 'installing'}
						mix={[
							css(installButtonCss),
							on('click', () => void submitInstall()),
						]}
						data-testid={`onboarding-starter-install-${listing.id}`}
					>
						{phase === 'installing' ? 'Installing…' : 'Install'}
					</button>
				)}
				{readyStatus ? (
					<p
						mix={css(starterStatusCss)}
						role="status"
						data-testid={`onboarding-starter-status-${listing.id}`}
					>
						{readyStatus}
					</p>
				) : null}
				{errorMessage ? (
					<p
						mix={css(starterErrorCss)}
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

export const starterCardCss = {
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.8rem',
	textAlign: 'center' as const,
	backgroundColor: colors.background,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	padding: '1.2rem 1.1rem',
	minWidth: 0,
	transition: `border-color 160ms ${transitions.easeOut}, transform 160ms ${transitions.easeOut}`,
	[hoverMq]: {
		'&:hover': {
			borderColor: colors.primary,
			transform: 'translateY(-2px)',
		},
		'&:hover [data-testid="community-listing-icon-starter"]': {
			borderColor: `oklch(from ${colors.primary} l c h / 0.55)`,
		},
		'&:hover a strong': {
			color: colors.primaryText,
		},
	},
	'&:active': { transform: 'translateY(0)' },
	'@media (prefers-reduced-motion: reduce)': {
		// Keep the border-color fade — reduced motion drops movement only.
		transition: `border-color 160ms ${transitions.easeOut}`,
		'&:hover': {
			transform: 'none',
		},
		'&:active': { transform: 'none' },
	},
	'& [data-testid="community-listing-icon-starter"]': {
		marginBottom: '0.2rem',
		transition: `border-color 160ms ${transitions.easeOut}`,
	},
}

const starterCardLinkCss = {
	flex: 1,
	display: 'flex',
	flexDirection: 'column' as const,
	alignItems: 'center',
	gap: '0.45rem',
	textDecoration: 'none',
	color: 'inherit',
	minWidth: 0,
}

const starterCardNameCss = {
	color: colors.text,
	fontWeight: 650,
	fontSize: '0.98rem',
	overflowWrap: 'anywhere' as const,
}

const starterCardDescriptionCss = {
	color: colors.textMuted,
	fontSize: '0.88rem',
	lineHeight: 1.45,
}

const starterActionButtonSizeCss = {
	width: '100%',
	fontSize: '0.95rem',
}

const installButtonCss = {
	...getPillButtonCss(),
	...starterActionButtonSizeCss,
}

export const starterGhostButtonCss = {
	...getGhostButtonCss(),
	...starterActionButtonSizeCss,
}

/*
 * CSS hover/focus tooltip instead of remix/ui popover: a top-layer popover
 * that flips into another card's Copy prompt steals pointer events and
 * jitters between vertically stacked starters. The tip is
 * `pointer-events: none` so it never becomes a hover target.
 */
export const starterCopyPromptTooltipCss = {
	position: 'relative' as const,
	'& [role="tooltip"]': {
		position: 'absolute' as const,
		left: '50%',
		bottom: 'calc(100% + 0.45rem)',
		transform: 'translateX(-50%)',
		width: 'max-content',
		maxWidth: 'min(16rem, calc(100vw - 2rem))',
		padding: `${spacing.xs} ${spacing.sm}`,
		borderRadius: radius.md,
		backgroundColor: colors.surface,
		color: colors.text,
		fontSize: typography.fontSize.sm,
		fontWeight: 400,
		lineHeight: 1.4,
		textAlign: 'left' as const,
		boxShadow: shadows.md,
		border: `1px solid ${colors.border}`,
		pointerEvents: 'none' as const,
		opacity: 0,
		visibility: 'hidden' as const,
		zIndex: 2,
	},
	'& [role="tooltip"]::after': {
		content: '""',
		position: 'absolute' as const,
		top: '100%',
		left: '50%',
		transform: 'translateX(-50%)',
		border: '6px solid transparent',
		borderTopColor: colors.surface,
	},
	[`${hoverMq} &:hover [role="tooltip"]`]: {
		opacity: 1,
		visibility: 'visible' as const,
	},
	'&:focus-visible [role="tooltip"]': {
		opacity: 1,
		visibility: 'visible' as const,
	},
}

const copyPromptButtonCss = {
	...getPillButtonCss(),
	...starterActionButtonSizeCss,
	...starterCopyPromptTooltipCss,
}

/* Install confirmation pops in like the wizard checks. */
const starterStatusCss = {
	margin: 0,
	fontSize: '0.85rem',
	color: colors.primaryText,
	textWrap: 'balance' as const,
	'@media (prefers-reduced-motion: no-preference)': {
		animation: `success-in 200ms ${transitions.easeOut} both`,
	},
}

const starterErrorCss = {
	...starterStatusCss,
	color: colors.error,
	textWrap: 'pretty' as const,
}
