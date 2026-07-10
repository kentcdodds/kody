import { type Handle, css } from 'remix/ui'
import { getOauthLoginErrorMessage } from '#app/oauth-login-errors.ts'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { ProviderIcon } from '#client/provider-icons.tsx'
import {
	startSocialSignIn,
	type AuthProviderInfo,
} from '#client/social-sign-in.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
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
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	noticeCardCss,
} from '#client/routes/account-management-components.tsx'
import { renderOnboardingBanner } from '#client/routes/onboarding-banner.tsx'
import {
	fetchOnboardingPayload,
	type OnboardingPayload,
} from '#client/routes/onboarding.tsx'
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

type AccountConnection = {
	provider: string
	label: string
	displayName: string | null
	createdAt: string
}

type AccountConnectionsPayload = {
	ok: true
	connections: Array<AccountConnection>
	canDisconnect: boolean
	availableProviders: Array<AuthProviderInfo>
}

const resendVerificationApiPath = '/account/resend-verification.json'
const emailChangeApiPath = '/account/email-change.json'
const connectionsApiPath = '/account/connections.json'

const providerLabels: Record<string, string> = {
	github: 'GitHub',
	google: 'Google',
	x: 'X',
}

/** One-shot message from the OAuth callback redirect query params. */
function readConnectionCallbackMessage(href: string) {
	const searchParams = new URL(href, 'http://localhost').searchParams
	const linkedProvider = searchParams.get('oauthLinked')
	if (linkedProvider) {
		return {
			text: `${providerLabels[linkedProvider] ?? linkedProvider} connected.`,
			tone: 'info' as const,
		}
	}
	const errorMessage = getOauthLoginErrorMessage(searchParams.get('oauthError'))
	if (errorMessage) {
		return { text: errorMessage, tone: 'error' as const }
	}
	return null
}

function isAccountPath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/account'
}

export async function accountRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const [profileResponse, onboarding] = await Promise.all([
		fetch(`${accountProfileApiPath}${url.search}`, {
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		}),
		fetchOnboardingPayload(signal),
	])
	if (profileResponse.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountProfilePayload>(profileResponse)
	if (!profileResponse.ok || !payload?.ok) {
		throw new Error('Unable to load your account.')
	}
	return {
		accountProfile: payload,
		...(onboarding ? { onboarding } : {}),
	}
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
	let connectionsStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
	let connectionsBusy = false
	let connections: Array<AccountConnection> = []
	let canDisconnect = true
	let availableProviders: Array<AuthProviderInfo> = []
	let connectionsMessage: { text: string; tone: 'error' | 'info' } | null = null
	let consumedCallbackMessage = false
	let needsOnboarding = false
	const loadLatch = createRouteLoadLatch()

	function applyConnectionsPayload(payload: AccountConnectionsPayload) {
		connections = payload.connections
		canDisconnect = payload.canDisconnect
		availableProviders = payload.availableProviders
	}

	async function loadConnections(signal: AbortSignal) {
		try {
			const response = await fetch(connectionsApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) {
				connectionsStatus = 'idle'
				return
			}
			const payload = await readJson<AccountConnectionsPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load connected accounts.')
			}
			applyConnectionsPayload(payload)
			connectionsStatus = 'ready'
			handle.update()
		} catch (error) {
			if (signal.aborted) {
				connectionsStatus = 'idle'
				return
			}
			connectionsStatus = 'error'
			connectionsMessage = {
				text:
					error instanceof Error
						? error.message
						: 'Unable to load connected accounts.',
				tone: 'error',
			}
			handle.update()
		}
	}

	async function handleConnectProvider(providerId: string) {
		connectionsBusy = true
		connectionsMessage = null
		handle.update()
		try {
			const errorMessage = await startSocialSignIn(providerId, null)
			if (errorMessage) {
				connectionsMessage = { text: errorMessage, tone: 'error' }
				connectionsBusy = false
			}
			// On success the browser is navigating to the provider; keep the
			// busy state until the page unloads.
		} catch {
			connectionsMessage = {
				text: 'Network error. Please try again.',
				tone: 'error',
			}
			connectionsBusy = false
		}
		handle.update()
	}

	async function handleDisconnectProvider(providerId: string) {
		connectionsBusy = true
		connectionsMessage = null
		handle.update()
		try {
			const response = await fetch(connectionsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ intent: 'disconnect', provider: providerId }),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountConnectionsPayload & { error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to disconnect the account.')
			}
			applyConnectionsPayload(payload)
			connectionsMessage = {
				text: `${providerLabels[providerId] ?? providerId} disconnected.`,
				tone: 'info',
			}
		} catch (error) {
			connectionsMessage = {
				text:
					error instanceof Error
						? error.message
						: 'Unable to disconnect the account.',
				tone: 'error',
			}
		} finally {
			connectionsBusy = false
			handle.update()
		}
	}

	function applyOnboardingPayload(payload: OnboardingPayload | null) {
		needsOnboarding = payload?.needsOnboarding === true
	}

	async function loadAccountProfile(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		try {
			const search = new URL(href, 'http://localhost').search
			const [response, onboarding] = await Promise.all([
				fetch(`${accountProfileApiPath}${search}`, {
					headers: { Accept: 'application/json' },
					credentials: 'include',
					signal,
				}),
				fetchOnboardingPayload(signal),
			])
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountProfilePayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load your account.')
			}
			applyOnboardingPayload(onboarding)
			email = payload.email
			emailVerified = payload.emailVerified
			username = payload.username
			draftUsername = payload.username
			draftEmail = payload.email
			status = 'ready'
			message = null
			messageTone = 'info'
			loadLatch.markLoaded(href)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load your account.'
			messageTone = 'error'
			loadLatch.markFailed(href)
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
		const onboardingData = tryConsumeRouteLoaderData(handle, 'onboarding', href)
		if (onboardingData) {
			applyOnboardingPayload(onboardingData)
		}
		status = 'ready'
		message = null
		messageTone = 'info'
		loadLatch.markLoaded(href)
		return true
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const appliedRouteData = applyRouteLoaderData(currentHref)
		// A same-path refresh whose loader failed leaves no preload and no
		// href change; the stale marker forces the fallback refetch.
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadAccountProfile)
		}
		if (typeof document !== 'undefined') {
			if (!consumedCallbackMessage) {
				consumedCallbackMessage = true
				connectionsMessage =
					readConnectionCallbackMessage(currentHref) ?? connectionsMessage
			}
			if (connectionsStatus === 'idle') {
				connectionsStatus = 'loading'
				handle.queueTask(loadConnections)
			}
		}
		const isSaving = saveStatus === 'saving'
		const isSendingEmailChange = emailChangeStatus === 'sending'
		const normalizedDraftUsername = draftUsername.trim().toLowerCase()
		const normalizedDraftEmail = draftEmail.trim().toLowerCase()

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Account"
					description="Manage your profile, integrations, approval requests, stored secrets, and package invocation tokens."
					currentHref={currentHref}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading account…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' ? (
					<>
						{needsOnboarding ? renderOnboardingBanner() : null}
						{!emailVerified ? (
							<section
								aria-label="Email verification status"
								mix={css(noticeCardCss)}
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
						<AccountManagementPanel
							title="Profile"
							description="Your username is unique and visible anywhere Kody needs a display name. Your email stays on the account for login."
						>
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
						</AccountManagementPanel>
						<AccountManagementPanel
							title="Security"
							description="Protect your account with two-factor authentication, or sign in without a password using passkeys."
						>
							<div mix={css({ display: 'flex', gap: spacing.md })}>
								<a href="/account/two-factor" mix={css(primaryLinkCss)}>
									Two-factor authentication
								</a>
								<a href="/account/passkeys" mix={css(primaryLinkCss)}>
									Passkeys
								</a>
							</div>
						</AccountManagementPanel>
						<AccountManagementPanel
							title="Connected accounts"
							description="Sign in with GitHub, Google, or X by connecting them to this account. Connections with the same verified email also link automatically at sign-in."
							ariaLabel="Connected accounts"
						>
							{connectionsMessage ? (
								<p
									role="status"
									mix={css({
										color:
											connectionsMessage.tone === 'error'
												? colors.error
												: colors.text,
										margin: 0,
									})}
								>
									{connectionsMessage.text}
								</p>
							) : null}
							{connectionsStatus === 'loading' ? (
								<p mix={css({ color: colors.textMuted, margin: 0 })}>
									Loading connected accounts…
								</p>
							) : null}
							{connectionsStatus === 'ready' ? (
								<div mix={css({ display: 'grid', gap: spacing.md })}>
									{connections.length > 0 ? (
										<ul
											mix={css({
												listStyle: 'none',
												padding: 0,
												margin: 0,
												display: 'grid',
												gap: spacing.md,
											})}
										>
											{connections.map((connection) => (
												<li
													key={connection.provider}
													mix={css({
														display: 'flex',
														justifyContent: 'space-between',
														alignItems: 'center',
														gap: spacing.md,
														flexWrap: 'wrap',
													})}
												>
													<span mix={css({ display: 'grid', gap: spacing.xs })}>
														<span
															mix={css({
																display: 'inline-flex',
																alignItems: 'center',
																gap: spacing.sm,
																fontWeight: typography.fontWeight.medium,
																color: colors.text,
															})}
														>
															<ProviderIcon providerId={connection.provider} />
															{connection.label}
														</span>
														<span
															mix={css({
																color: colors.textMuted,
																fontSize: typography.fontSize.sm,
															})}
														>
															{connection.displayName
																? `Connected as ${connection.displayName}`
																: 'Connected'}
														</span>
													</span>
													<button
														type="button"
														disabled={connectionsBusy || !canDisconnect}
														title={
															canDisconnect
																? undefined
																: 'This connection is your only way to sign in. Set a password or register a passkey first.'
														}
														mix={[
															css(dangerButtonCss),
															on('click', () =>
																handleDisconnectProvider(connection.provider),
															),
														]}
													>
														Disconnect
													</button>
												</li>
											))}
										</ul>
									) : (
										<p mix={css({ color: colors.textMuted, margin: 0 })}>
											No accounts connected yet.
										</p>
									)}
									{availableProviders.length > 0 ? (
										<div
											mix={css({
												display: 'flex',
												gap: spacing.md,
												flexWrap: 'wrap',
											})}
										>
											{availableProviders.map((provider) => (
												<button
													type="button"
													disabled={connectionsBusy}
													mix={[
														css(providerConnectButtonCss),
														on('click', () =>
															handleConnectProvider(provider.id),
														),
													]}
												>
													<ProviderIcon providerId={provider.id} />
													Connect {provider.label}
												</button>
											))}
										</div>
									) : null}
								</div>
							) : null}
						</AccountManagementPanel>
						<AccountManagementPanel
							title="Secret management"
							description="Create, edit, and delete secrets from the dedicated management page."
						>
							<div>
								<a href="/account/secrets" mix={css(primaryLinkCss)}>
									Manage secrets
								</a>
							</div>
						</AccountManagementPanel>
						<AccountManagementPanel
							title="Your data"
							description="Download a portable JSON export of your Kody account data for backup or migration. Secret values are never included; secret entries export metadata such as names, hosts, and allowlists only."
						>
							<div>
								<a
									href="/account/export.json"
									download="kody-account-export.json"
									mix={css(primaryLinkCss)}
								>
									Download account export
								</a>
							</div>
						</AccountManagementPanel>
						<AccountManagementPanel
							title="Integrations"
							description="Review saved OAuth provider configurations and reconnect integrations when tokens need to be refreshed."
						>
							<div>
								<a href="/account/integrations" mix={css(primaryLinkCss)}>
									Manage integrations
								</a>
							</div>
						</AccountManagementPanel>
						<AccountManagementPanel
							title="Package invocation tokens"
							description="Create and revoke bearer tokens for trusted personal clients that call saved package exports."
						>
							<div>
								<a
									href="/account/package-invocation-tokens"
									mix={css(primaryLinkCss)}
								>
									Manage package tokens
								</a>
							</div>
						</AccountManagementPanel>
						<AccountManagementPanel
							title="MCP servers"
							description="Connect remote MCP servers so their tools become Kody capabilities, including OAuth-protected servers."
						>
							<div>
								<a href="/account/mcp-servers" mix={css(primaryLinkCss)}>
									Manage MCP servers
								</a>
							</div>
						</AccountManagementPanel>
						<AccountManagementPanel
							title="Remote connectors"
							description="Attach generic remote connector refs to normal Kody sessions and manage their connector hello shared secrets."
						>
							<div>
								<a href="/account/remote-connectors" mix={css(primaryLinkCss)}>
									Manage remote connectors
								</a>
							</div>
						</AccountManagementPanel>
					</>
				) : null}

				<p mix={css({ margin: 0 })}>
					<a href="/privacy" mix={css(mutedLinkCss)}>
						Privacy
					</a>
				</p>
			</AccountManagementShell>
		)
	}
}

const primaryButtonCss = getPrimaryButtonCss()
const secondaryButtonCss = getSecondaryButtonCss()
const dangerButtonCss = getDangerButtonCss()

const providerConnectButtonCss = {
	...secondaryButtonCss,
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: spacing.sm,
}
