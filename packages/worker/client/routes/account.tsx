import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	inputCss,
	layoutMaxWidths,
	mutedLinkCss,
	primaryLinkCss,
} from '#client/styles/style-primitives.ts'
import { queueSessionRefresh } from '#client/session.ts'
import {
	type AccountStatus,
	accountProfileApiPath,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

type AccountProfilePayload = {
	ok: true
	email: string
	emailVerified: boolean
	username: string
	displayName: string
}

const resendVerificationApiPath = '/account/resend-verification.json'
const emailChangeApiPath = '/account/email-change.json'

function isAccountPath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/account'
}

export async function accountRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(`${accountProfileApiPath}${url.search}`, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountProfilePayload>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load your account.')
	}
	return { accountProfile: payload }
}

export function AccountRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let saveStatus: 'idle' | 'saving' = 'idle'
	let resendStatus: 'idle' | 'sending' = 'idle'
	let emailChangeStatus: 'idle' | 'sending' = 'idle'
	let resendMessage: string | null = null
	let resendTone: 'error' | 'info' = 'info'
	let email = ''
	let emailVerified = false
	let username = ''
	let draftUsername = ''
	let draftEmail = ''
	let emailChangePassword = ''
	let message: string | null = null
	let messageTone: 'error' | 'info' = 'info'
	let emailChangeMessage: string | null = null
	let emailChangeTone: 'error' | 'info' = 'info'
	let lastLoadedHref = ''

	async function loadAccountProfile(signal: AbortSignal) {
		try {
			const href = readCurrentRouterHref(handle)
			const search = new URL(href, 'http://localhost').search
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
			emailVerified = payload.emailVerified
			username = payload.username
			draftUsername = payload.username
			draftEmail = payload.email
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

	async function handleResendVerification() {
		resendStatus = 'sending'
		resendMessage = null
		resendTone = 'info'
		handle.update()

		try {
			const response = await fetch(resendVerificationApiPath, {
				method: 'POST',
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<{
				ok?: boolean
				message?: string
				error?: string
			}>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(
					payload?.error || 'Unable to send the verification email.',
				)
			}
			resendMessage =
				payload.message ?? 'Verification email sent. Check your inbox.'
			resendTone = 'info'
		} catch (error) {
			resendMessage =
				error instanceof Error
					? error.message
					: 'Unable to send the verification email.'
			resendTone = 'error'
		} finally {
			resendStatus = 'idle'
			handle.update()
		}
	}

	function updateDraftUsername(event: InputEvent) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		draftUsername = event.currentTarget.value
		handle.update()
	}

	function updateDraftEmail(event: InputEvent) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		draftEmail = event.currentTarget.value
		handle.update()
	}

	function updateEmailChangePassword(event: InputEvent) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		emailChangePassword = event.currentTarget.value
		handle.update()
	}

	async function handleEmailChangeSubmit(event: SubmitEvent) {
		event.preventDefault()
		const nextEmail = draftEmail.trim().toLowerCase()
		if (!nextEmail || !emailChangePassword) {
			emailChangeMessage = 'New email and current password are required.'
			emailChangeTone = 'error'
			handle.update()
			return
		}
		if (nextEmail === email.trim().toLowerCase()) {
			emailChangeMessage = 'Enter a different email address.'
			emailChangeTone = 'error'
			handle.update()
			return
		}

		emailChangeStatus = 'sending'
		emailChangeMessage = null
		emailChangeTone = 'info'
		handle.update()

		try {
			const response = await fetch(emailChangeApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					email: nextEmail,
					password: emailChangePassword,
				}),
			})
			if (response.status === 401) {
				const payload = await readJson<{ code?: string; error?: string }>(
					response,
				)
				if (payload?.code === 'invalid_password') {
					throw new Error(payload.error)
				}
				window.location.assign('/login')
				return
			}
			const payload = await readJson<{
				ok?: boolean
				message?: string
				error?: string
			}>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(
					payload?.error || 'Unable to send the email change verification.',
				)
			}
			emailChangePassword = ''
			emailChangeMessage =
				payload.message ?? 'Verification email sent to your new address.'
			emailChangeTone = 'info'
		} catch (error) {
			emailChangeMessage =
				error instanceof Error
					? error.message
					: 'Unable to send the email change verification.'
			emailChangeTone = 'error'
		} finally {
			emailChangeStatus = 'idle'
			handle.update()
		}
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
			emailVerified = payload.emailVerified
			username = payload.username
			draftUsername = payload.username
			message = 'Username saved.'
			messageTone = 'info'
			queueSessionRefresh()
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to save username.'
			messageTone = 'error'
		} finally {
			saveStatus = 'idle'
			handle.update()
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!isAccountPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'accountProfile', href)
		if (!routeData) return false
		email = routeData.email
		emailVerified = routeData.emailVerified
		username = routeData.username
		draftUsername = routeData.username
		draftEmail = routeData.email
		status = 'ready'
		message = null
		messageTone = 'info'
		lastLoadedHref = href
		return true
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const appliedRouteData = applyRouteLoaderData(currentHref)
		// A same-path refresh whose loader failed leaves no preload and no
		// href change; the stale marker forces the fallback refetch.
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const isRefreshingForLocationChange =
			status !== 'loading' && currentHref !== lastLoadedHref
		if (
			!appliedRouteData &&
			(status === 'loading' ||
				isRefreshingForLocationChange ||
				needsStaleRefresh) &&
			typeof document !== 'undefined'
		) {
			handle.queueTask(loadAccountProfile)
		}
		const isSaving = saveStatus === 'saving'
		const isSendingEmailChange = emailChangeStatus === 'sending'
		const normalizedDraftUsername = draftUsername.trim().toLowerCase()
		const normalizedDraftEmail = draftEmail.trim().toLowerCase()

		return (
			<section
				mix={css({
					maxWidth: layoutMaxWidths.content,
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
						{!emailVerified ? (
							<section
								aria-label="Email verification status"
								mix={css({
									...cardCss,
									borderColor: colors.primary,
									backgroundColor: colors.primarySoftest,
								})}
							>
								<h2 mix={css(cardTitleCss)}>Verify your email</h2>
								<p mix={css(descriptionCss)}>
									Check your inbox for the verification link. MCP access and
									email features stay disabled until this account email is
									verified.
								</p>
								<div>
									<button
										type="button"
										disabled={resendStatus === 'sending'}
										mix={[
											css(primaryButtonCss),
											on('click', handleResendVerification),
										]}
									>
										{resendStatus === 'sending'
											? 'Sending...'
											: 'Resend verification email'}
									</button>
								</div>
								{resendMessage ? (
									<p
										role="status"
										mix={css({
											color:
												resendTone === 'error' ? colors.error : colors.text,
											margin: 0,
										})}
									>
										{resendMessage}
									</p>
								) : null}
							</section>
						) : null}
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
									Email: {email} ({emailVerified ? 'verified' : 'unverified'})
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
							<form
								mix={[
									css({
										display: 'grid',
										gap: spacing.md,
										marginTop: spacing.lg,
										paddingTop: spacing.lg,
										borderTop: `1px solid ${colors.border}`,
									}),
									on('submit', handleEmailChangeSubmit),
								]}
							>
								<div mix={css({ display: 'grid', gap: spacing.xs })}>
									<h3
										mix={css({
											fontSize: typography.fontSize.base,
											fontWeight: typography.fontWeight.semibold,
											color: colors.text,
											margin: 0,
										})}
									>
										Change email
									</h3>
									<p mix={css(descriptionCss)}>
										Enter your current password. We will send a verification
										link to the new address before changing your account email.
									</p>
								</div>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>New email</span>
									<input
										type="email"
										name="email"
										required
										autoComplete="email"
										value={draftEmail}
										mix={[css(inputCss), on('input', updateDraftEmail)]}
									/>
								</label>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Current password</span>
									<input
										type="password"
										name="password"
										required
										autoComplete="current-password"
										value={emailChangePassword}
										mix={[
											css(inputCss),
											on('input', updateEmailChangePassword),
										]}
									/>
								</label>
								<div>
									<button
										type="submit"
										disabled={
											isSendingEmailChange ||
											normalizedDraftEmail === email.trim().toLowerCase()
										}
										mix={css(primaryButtonCss)}
									>
										{isSendingEmailChange
											? 'Sending...'
											: 'Send verification link'}
									</button>
								</div>
								{emailChangeMessage ? (
									<p
										role="status"
										mix={css({
											color:
												emailChangeTone === 'error'
													? colors.error
													: colors.text,
											margin: 0,
										})}
									>
										{emailChangeMessage}
									</p>
								) : null}
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
							<h2 mix={css(cardTitleCss)}>Your data</h2>
							<p mix={css(descriptionCss)}>
								Download a portable JSON export of your Kody account data for
								backup or migration. Secret values are never included; secret
								entries export metadata such as names, hosts, and allowlists
								only.
							</p>
							<div>
								<a
									href="/account/export.json"
									download="kody-account-export.json"
									mix={css(primaryLinkCss)}
								>
									Download account export
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
