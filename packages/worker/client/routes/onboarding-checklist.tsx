import { type Handle, css } from 'remix/ui'
import { routes } from '#app/routes.ts'
import {
	type OnboardingChecklistItemId,
	type OnboardingChecklistLoaderData,
} from '#app/loader-data.ts'
import { on } from '#client/event-mixin.ts'
import { ProviderIcon } from '#client/provider-icons.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { onboardingPath } from '#client/routes/onboarding-redirect.ts'
import { colors, radius, typography } from '#client/styles/tokens.ts'
import {
	getGhostButtonCss,
	primaryLinkCss,
} from '#client/styles/style-primitives.ts'

export const onboardingChecklistItemLabels: Record<
	OnboardingChecklistItemId,
	string
> = {
	'verify-email': 'Verify your email',
	'connect-agent': 'Connect your agent',
	'first-hello': 'Exchange a first email with Kody',
	'save-memory': 'Save a memory',
	'connect-integration': 'Connect an integration',
	'install-starter': 'Install a starter package',
}

const integrationGuideProviders = [
	{ id: 'google', label: 'Google', href: '/guides/google' },
	{ id: 'github', label: 'GitHub', href: '/guides/github' },
	{ id: 'spotify', label: 'Spotify', href: '/guides/spotify' },
	{ id: 'notion', label: 'Notion', href: '/guides/notion' },
] as const

function readChecklistItemHref(id: OnboardingChecklistItemId): string | null {
	switch (id) {
		case 'verify-email':
			return '/pending-verification'
		case 'connect-agent':
			return `${onboardingPath}#connect-agent`
		case 'first-hello':
		case 'save-memory':
			return `${onboardingPath}#first-win`
		case 'connect-integration':
			return null
		case 'install-starter':
			return `${onboardingPath}#starter-packages`
		default: {
			const neverId: never = id
			return neverId
		}
	}
}

export function shouldShowOnboardingChecklist(
	checklist: OnboardingChecklistLoaderData | null | undefined,
): checklist is OnboardingChecklistLoaderData {
	if (!checklist || checklist.dismissed) return false
	return checklist.items.some((item) => !item.done)
}

export function getFirstUndoneChecklistItemLabel(
	checklist: OnboardingChecklistLoaderData,
): string | null {
	const undone = checklist.items.find((item) => !item.done)
	return undone ? onboardingChecklistItemLabels[undone.id] : null
}

type OnboardingChecklistCardProps = {
	checklist: OnboardingChecklistLoaderData
	onDismissed?: () => void
}

/**
 * Derived onboarding progress surfaced on /onboarding while items remain
 * incomplete and the user has not dismissed the card.
 */
export function OnboardingChecklistCard(
	handle: Handle<OnboardingChecklistCardProps>,
) {
	let dismissing = false
	let dismissError: string | null = null

	async function dismiss() {
		if (dismissing) return
		dismissing = true
		dismissError = null
		handle.update()

		try {
			const response = await fetch(
				routes.onboardingChecklistDismissPost.href(),
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
				window.location.assign('/login')
				return
			}
			const payload = await readJson<{ ok?: boolean }>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to dismiss checklist.')
			}
			handle.props.onDismissed?.()
		} catch (error) {
			dismissError =
				error instanceof Error ? error.message : 'Unable to dismiss checklist.'
		} finally {
			dismissing = false
			handle.update()
		}
	}

	return () => {
		const { checklist } = handle.props

		return (
			<section
				aria-label="Onboarding checklist"
				data-testid="onboarding-checklist"
				mix={css(checklistCardCss)}
			>
				<div mix={css(checklistHeadCss)}>
					<h2 mix={css(checklistTitleCss)}>Your setup checklist</h2>
					<button
						type="button"
						aria-label="Dismiss checklist"
						disabled={dismissing}
						mix={[css(dismissButtonCss), on('click', () => void dismiss())]}
					>
						Dismiss
					</button>
				</div>
				{dismissError ? (
					<p mix={css(checklistErrorCss)} role="alert">
						{dismissError}
					</p>
				) : null}
				<ul mix={css(checklistListCss)}>
					{checklist.items.map((item) => {
						const label = onboardingChecklistItemLabels[item.id]
						const href = readChecklistItemHref(item.id)
						const isIntegration = item.id === 'connect-integration'

						return (
							<li
								key={item.id}
								mix={css(checklistItemCss)}
								data-done={item.done ? 'true' : undefined}
							>
								<span mix={css(checklistMarkCss)} aria-hidden="true">
									{item.done ? '✓' : '○'}
								</span>
								<div mix={css(checklistItemBodyCss)}>
									{item.done || !href ? (
										<span mix={css(checklistLabelCss)}>{label}</span>
									) : (
										<a href={href} mix={css(checklistLinkCss)}>
											{label}
										</a>
									)}
									{isIntegration && !item.done ? (
										<p mix={css(integrationHintCss)}>
											Try{' '}
											{integrationGuideProviders.map((provider, index) => (
												<span key={provider.id} mix={css(providerEntryCss)}>
													<a
														href={provider.href}
														mix={css(integrationProviderLinkCss)}
													>
														<ProviderIcon providerId={provider.id} size="1em" />
														{provider.label}
													</a>
													{index < integrationGuideProviders.length - 2
														? ', '
														: index === integrationGuideProviders.length - 2
															? ', or '
															: null}
												</span>
											))}
										</p>
									) : null}
								</div>
							</li>
						)
					})}
				</ul>
			</section>
		)
	}
}

const checklistCardCss = {
	marginTop: '1rem',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	padding: '1.1rem 1.25rem',
	display: 'grid',
	gap: '0.85rem',
	minWidth: 0,
}

const checklistHeadCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: '0.8rem',
}

const checklistTitleCss = {
	margin: 0,
	font: `700 1rem/1.3 ${typography.fontFamilyDisplay}`,
	letterSpacing: '-0.01em',
}

const dismissButtonCss = {
	...getGhostButtonCss(),
	fontSize: '0.88rem',
	padding: '0.35rem 0.75rem',
}

const checklistErrorCss = {
	margin: 0,
	color: colors.error,
	fontSize: '0.92rem',
}

const checklistListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: '0.55rem',
}

const checklistItemCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: '0.65rem',
	fontSize: '0.96rem',
	lineHeight: 1.45,
	'&[data-done]': {
		color: colors.textMuted,
	},
}

const checklistMarkCss = {
	flex: 'none',
	width: '1.35rem',
	fontWeight: 700,
	textAlign: 'center' as const,
	color: colors.primaryText,
	'li[data-done] &': {
		color: colors.textMuted,
	},
}

const checklistItemBodyCss = {
	display: 'grid',
	gap: '0.25rem',
	minWidth: 0,
}

const checklistLabelCss = {
	'li[data-done] &': {
		textDecoration: 'line-through',
	},
}

const checklistLinkCss = {
	...primaryLinkCss,
	fontWeight: 600,
	textDecoration: 'none',
	'&:hover': {
		textDecoration: 'underline',
	},
}

const integrationHintCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.9rem',
}

/** Keeps the separator hugging its provider label instead of the next icon. */
const providerEntryCss = {
	whiteSpace: 'nowrap' as const,
}

const integrationProviderLinkCss = {
	...primaryLinkCss,
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.3rem',
	fontWeight: 550,
	textDecoration: 'none',
	'&:hover': {
		textDecoration: 'underline',
	},
}
