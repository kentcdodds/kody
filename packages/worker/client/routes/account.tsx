import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	inputCss,
	mutedLinkCss,
	primaryLinkCss,
} from '#client/styles/style-primitives.ts'
import {
	type AccountStatus,
	accountProfileApiPath,
	readJson,
} from '#client/routes/account-approval-shared.ts'

type AccountProfilePayload = {
	ok: true
	email: string
	username: string
}

type SaveStatus = 'idle' | 'saving'
type MessageTone = 'error' | 'info'

export function AccountRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let saveStatus: SaveStatus = 'idle'
	let email = ''
	let username = ''
	let draftUsername = ''
	let message: string | null = null
	let messageTone: MessageTone = 'info'
	let lastLoadedHref = ''

	async function loadAccountProfile(signal: AbortSignal) {
		try {
			const href =
				typeof window === 'undefined' ? '/account' : window.location.href
			const search = typeof window === 'undefined' ? '' : new URL(href).search
			lastLoadedHref = href
			const response = await fetch(`${accountProfileApiPath}${search}`, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountProfilePayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load your account.')
			}
			email = payload.email
			username = payload.username
			draftUsername = payload.username
			status = 'ready'
			message = null
			messageTone = 'info'
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load your account.'
			messageTone = 'error'
			handle.update()
		}
	}

	function updateDraftUsername(event: InputEvent) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		draftUsername = event.currentTarget.value
		handle.update()
	}

	async function handleUsernameSubmit(event: SubmitEvent) {
		event.preventDefault()
		const nextUsername = draftUsername.trim()
		if (!nextUsername) {
			message = 'Username is required.'
			messageTone = 'error'
			handle.update()
			return
		}

		saveStatus = 'saving'
		message = null
		messageTone = 'info'
		handle.update()

		try {
			const response = await fetch(accountProfileApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ username: nextUsername }),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountProfilePayload & { error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to save username.')
			}
			email = payload.email
			username = payload.username
			draftUsername = payload.username
			message = 'Username saved.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to save username.'
			messageTone = 'error'
		} finally {
			saveStatus = 'idle'
			handle.update()
		}
	}

	return () => {
		const currentHref =
			typeof window === 'undefined' ? '/account' : window.location.href
		const isRefreshingForLocationChange =
			status !== 'loading' && currentHref !== lastLoadedHref
		if (status === 'loading' || isRefreshingForLocationChange) {
			handle.queueTask(loadAccountProfile)
		}
		const isSaving = saveStatus === 'saving'
		const normalizedDraftUsername = draftUsername.trim().toLowerCase()

		return (
			<section
				mix={css({
					maxWidth: '64rem',
					margin: '0 auto',
					display: 'grid',
					gap: spacing.xl,
				})}
			>
				<header mix={css({ display: 'grid', gap: spacing.xs })}>
					<h1
						mix={css({
							fontSize: typography.fontSize.xl,
							fontWeight: typography.fontWeight.semibold,
							color: colors.text,
							margin: 0,
						})}
					>
						{username ? `${username} account` : 'Account'}
					</h1>
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Manage your profile, integrations, approval requests, stored
						secrets, and package invocation tokens.
					</p>
				</header>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading account…
					</p>
				) : null}
				{message ? (
					<p
						role="alert"
						mix={css({
							color: messageTone === 'error' ? colors.error : colors.text,
						})}
					>
						{message}
					</p>
				) : null}

				{status === 'ready' ? (
					<>
						<section mix={css(cardCss)}>
							<h2 mix={css(cardTitleCss)}>Profile</h2>
							<p mix={css(descriptionCss)}>
								Your username is unique and visible anywhere Kody needs a
								display name. Your email stays on the account for login.
							</p>
							<form
								mix={[
									css({ display: 'grid', gap: spacing.md }),
									on('submit', handleUsernameSubmit),
								]}
							>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Username</span>
									<input
										type="text"
										name="username"
										required
										autoComplete="username"
										pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,30}[A-Za-z0-9]"
										title="Use 3 to 32 letters, numbers, hyphens, or underscores. Start and end with a letter or number."
										value={draftUsername}
										mix={[css(inputCss), on('input', updateDraftUsername)]}
									/>
								</label>
								<p mix={css({ color: colors.textMuted, margin: 0 })}>
									Email: {email}
								</p>
								<div>
									<button
										type="submit"
										disabled={isSaving || normalizedDraftUsername === username}
										mix={css(primaryButtonCss)}
									>
										{isSaving ? 'Saving...' : 'Save username'}
									</button>
								</div>
							</form>
						</section>
						<section mix={css(cardCss)}>
							<h2 mix={css(cardTitleCss)}>Secret management</h2>
							<p mix={css(descriptionCss)}>
								Create, edit, and delete secrets from the dedicated management
								page.
							</p>
							<div>
								<a href="/account/secrets" mix={css(primaryLinkCss)}>
									Manage secrets
								</a>
							</div>
						</section>
						<section mix={css(cardCss)}>
							<h2 mix={css(cardTitleCss)}>Integrations</h2>
							<p mix={css(descriptionCss)}>
								Review saved OAuth provider configurations and reconnect
								integrations when tokens need to be refreshed.
							</p>
							<div>
								<a href="/account/integrations" mix={css(primaryLinkCss)}>
									Manage integrations
								</a>
							</div>
						</section>
						<section mix={css(cardCss)}>
							<h2 mix={css(cardTitleCss)}>Package invocation tokens</h2>
							<p mix={css(descriptionCss)}>
								Create and revoke bearer tokens for trusted personal clients
								that call saved package exports.
							</p>
							<div>
								<a
									href="/account/package-invocation-tokens"
									mix={css(primaryLinkCss)}
								>
									Manage package tokens
								</a>
							</div>
						</section>
						<section mix={css(cardCss)}>
							<h2 mix={css(cardTitleCss)}>Remote connectors</h2>
							<p mix={css(descriptionCss)}>
								Attach generic remote connector refs to normal Kody sessions and
								manage their connector hello shared secrets.
							</p>
							<div>
								<a href="/account/remote-connectors" mix={css(primaryLinkCss)}>
									Manage remote connectors
								</a>
							</div>
						</section>
					</>
				) : null}

				<p mix={css({ margin: 0 })}>
					<a href="/privacy" mix={css(mutedLinkCss)}>
						Privacy
					</a>
				</p>
			</section>
		)
	}
}

const primaryButtonCss = getPrimaryButtonCss()
