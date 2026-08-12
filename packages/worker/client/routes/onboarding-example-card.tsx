import { type Handle, css } from 'remix/ui'
import { getCommunityListingHref } from '#universal/community-links.ts'
import { routes } from '#universal/routes.ts'
import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'
import { buildOnboardingExamplePrompt } from '#universal/onboarding-examples.ts'
import { CommunityListingIcon } from '#universal/community-listing-icon.tsx'
import { writeClipboardText } from '#client/clipboard.ts'
import { on } from '#client/event-mixin.ts'
import {
	ActionButtonLoader,
	installProgressWords,
} from '#client/action-button-loader.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, radius, transitions } from '#universal/styles/tokens.ts'
import {
	getPillButtonCss,
	hoverMq,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import {
	starterCardCss,
	starterCopyPromptTooltipCss,
} from '#client/routes/onboarding-starter-card.tsx'

type OnboardingExampleCardProps = {
	listing: OnboardingFeaturedListing
	loggedIn: boolean
	/** Called when install finishes so the parent can refresh checklist state. */
	onInstalled?: () => void
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
	'Copies a short prompt you can paste into your agent right away — even while install finishes.'

/**
 * Step 2 example card: one click starts install/fork and immediately offers
 * the copyable agent prompt so the first build is not blocked on the ~7s+
 * Artifacts bootstrap floor.
 */
export function OnboardingExampleCard(
	handle: Handle<OnboardingExampleCardProps>,
) {
	let phase: CardPhase = 'idle'
	let statusMessage: string | null = null
	let errorMessage: string | null = null
	let copyState: 'idle' | 'copied' | 'error' = 'idle'
	let copyResetTimerId: ReturnType<typeof setTimeout> | null = null
	let selected = false

	async function submitInstall() {
		const { listing, loggedIn } = handle.props
		if (!loggedIn) {
			window.location.assign(
				`/login?redirectTo=${encodeURIComponent('/onboarding')}`,
			)
			return
		}
		if (phase === 'installing') return

		selected = true
		phase = 'installing'
		errorMessage = null
		statusMessage = 'Installing into your account…'
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
				!payload.targetName
			) {
				throw new Error(
					payload?.error ?? 'Unable to install this community package.',
				)
			}
			statusMessage =
				payload.status === 'installed'
					? `Installed as ${payload.targetName}.`
					: `Forked as ${payload.targetName}; needs adaptation before it can run.`
			phase = 'ready'
			handle.props.onInstalled?.()
			handle.update()
		} catch (error) {
			phase = 'error'
			statusMessage = null
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
		const detailHref = getCommunityListingHref({
			listingId: listing.id,
			listingName: listing.name,
			kodyId: listing.kodyId,
		})
		const existingInstall = listing.viewerInstall ?? null
		const alreadyReady = existingInstall != null
		const showExpandedPrompt =
			selected || phase === 'installing' || phase === 'error'
		const examplePrompt = buildOnboardingExamplePrompt({
			listingName: listing.name,
			kodyId: listing.kodyId,
		})
		const readyStatus =
			phase === 'error'
				? null
				: (statusMessage ??
					(existingInstall
						? existingInstall.status === 'installed'
							? `Installed as ${existingInstall.targetName}.`
							: `Forked as ${existingInstall.targetName}; needs adaptation before it can run.`
						: null))

		return (
			<li
				mix={css(exampleCardCss)}
				data-testid={`onboarding-example-${listing.id}`}
				data-selected={showExpandedPrompt ? 'true' : undefined}
			>
				<a
					href={detailHref}
					target="_blank"
					rel="noreferrer noopener"
					mix={css(exampleCardLinkCss)}
				>
					<CommunityListingIcon listing={listing} size="starter" />
					<strong mix={css(exampleCardNameCss)}>{listing.name}</strong>
					<span mix={css(exampleCardDescriptionCss)}>
						{listing.description}
					</span>
				</a>
				{showExpandedPrompt ? (
					<>
						<figure mix={css(examplePromptBlockCss)}>
							<blockquote
								data-testid={`onboarding-example-prompt-${listing.id}`}
							>
								{examplePrompt}
							</blockquote>
						</figure>
						<button
							type="button"
							aria-describedby={`onboarding-example-prompt-tip-${listing.id}`}
							mix={[
								css(exampleCopyButtonCss),
								on('click', () => void copyPrompt(examplePrompt)),
							]}
							data-testid={`onboarding-example-copy-${listing.id}`}
						>
							{copyState === 'copied'
								? 'Copied'
								: copyState === 'error'
									? 'Copy failed'
									: 'Copy prompt'}
							<span
								id={`onboarding-example-prompt-tip-${listing.id}`}
								role="tooltip"
							>
								{copyPromptTooltip}
							</span>
						</button>
						{phase === 'installing' ? (
							<>
								<p
									mix={css(exampleStatusCss)}
									role="status"
									data-testid={`onboarding-example-installing-${listing.id}`}
								>
									<ActionButtonLoader
										label="Installing"
										words={installProgressWords}
									/>
								</p>
								<p mix={css(exampleHintCss)}>
									You can copy the prompt now. Your agent waits until the
									install/fork is ready, then runs your copy of the package.
								</p>
							</>
						) : null}
						{readyStatus && phase !== 'installing' ? (
							<p
								mix={css(exampleStatusCss)}
								role="status"
								data-testid={`onboarding-example-status-${listing.id}`}
							>
								{readyStatus} Paste the prompt into your agent — it waits for
								the install if needed.
							</p>
						) : null}
						<p mix={css(exampleGuideCss)}>
							<a
								href="/guides/quick-example"
								target="_blank"
								rel="noreferrer noopener"
								mix={css(primaryLinkCss)}
							>
								Read the quick-example guide
							</a>
						</p>
					</>
				) : alreadyReady ? (
					<button
						type="button"
						aria-describedby={`onboarding-example-prompt-tip-${listing.id}`}
						mix={[
							css(exampleCopyButtonCss),
							on('click', () => {
								selected = true
								void copyPrompt(examplePrompt)
							}),
						]}
						data-testid={`onboarding-example-copy-${listing.id}`}
					>
						{copyState === 'copied'
							? 'Copied'
							: copyState === 'error'
								? 'Copy failed'
								: 'Copy prompt'}
						<span
							id={`onboarding-example-prompt-tip-${listing.id}`}
							role="tooltip"
						>
							{copyPromptTooltip}
						</span>
					</button>
				) : (
					<button
						type="button"
						mix={[
							css(exampleTryButtonCss),
							on('click', () => void submitInstall()),
						]}
						data-testid={`onboarding-example-try-${listing.id}`}
					>
						Try this
					</button>
				)}
				{!showExpandedPrompt && readyStatus ? (
					<p
						mix={css(exampleStatusCss)}
						role="status"
						data-testid={`onboarding-example-status-${listing.id}`}
					>
						{readyStatus}
					</p>
				) : null}
				{errorMessage ? (
					<p
						mix={css(exampleErrorCss)}
						role="alert"
						data-testid={`onboarding-example-error-${listing.id}`}
					>
						{errorMessage}{' '}
						<button
							type="button"
							mix={[
								css(exampleRetryLinkCss),
								on('click', () => void submitInstall()),
							]}
						>
							Retry install
						</button>
					</p>
				) : null}
			</li>
		)
	}
}

const exampleCardCss = {
	...starterCardCss,
	'&[data-selected]': {
		borderColor: colors.primary,
		gridColumn: '1 / -1',
		textAlign: 'left' as const,
		[hoverMq]: {
			'&:hover': {
				transform: 'none',
			},
		},
	},
}

const exampleCardLinkCss = {
	flex: 1,
	display: 'flex',
	flexDirection: 'column' as const,
	alignItems: 'center',
	gap: '0.45rem',
	textDecoration: 'none',
	color: 'inherit',
	minWidth: 0,
	'[data-selected] &': {
		flexDirection: 'row' as const,
		alignItems: 'flex-start',
		textAlign: 'left' as const,
		gap: '0.85rem',
	},
}

const exampleCardNameCss = {
	color: colors.text,
	fontWeight: 650,
	fontSize: '0.98rem',
	overflowWrap: 'anywhere' as const,
}

const exampleCardDescriptionCss = {
	color: colors.textMuted,
	fontSize: '0.88rem',
	lineHeight: 1.45,
}

const exampleTryButtonCss = {
	...getPillButtonCss(),
	width: '100%',
	fontSize: '0.95rem',
}

const exampleCopyButtonCss = {
	...getPillButtonCss(),
	width: '100%',
	fontSize: '0.95rem',
	...starterCopyPromptTooltipCss,
	'[data-selected] &': {
		width: 'auto',
		justifySelf: 'start',
	},
}

const examplePromptBlockCss = {
	margin: 0,
	minWidth: 0,
	width: '100%',
	'& blockquote': {
		margin: 0,
		overflowWrap: 'anywhere' as const,
		fontSize: '0.94rem',
		lineHeight: 1.55,
		color: colors.text,
		backgroundColor: colors.background,
		border: `1.5px solid ${colors.border}`,
		borderRadius: radius.card,
		padding: '1rem 1.15rem',
	},
}

const exampleStatusCss = {
	margin: 0,
	fontSize: '0.85rem',
	color: colors.primaryText,
	textWrap: 'balance' as const,
	'@media (prefers-reduced-motion: no-preference)': {
		animation: `success-in 200ms ${transitions.easeOut} both`,
	},
}

const exampleHintCss = {
	margin: 0,
	fontSize: '0.88rem',
	color: colors.textMuted,
	lineHeight: 1.5,
}

const exampleErrorCss = {
	...exampleStatusCss,
	color: colors.error,
	textWrap: 'pretty' as const,
}

const exampleRetryLinkCss = {
	appearance: 'none' as const,
	border: 0,
	background: 'none',
	padding: 0,
	color: colors.primaryText,
	font: 'inherit',
	fontWeight: 650,
	textDecoration: 'underline',
	cursor: 'pointer',
}

const exampleGuideCss = {
	margin: 0,
	fontSize: '0.88rem',
	color: colors.textMuted,
}
