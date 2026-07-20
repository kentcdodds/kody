import { type Handle, css } from 'remix/ui'
import { getOauthLoginErrorMessage } from '#app/oauth-login-errors.ts'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { ProviderIcon } from '#client/provider-icons.tsx'
import { startSocialSignIn } from '#client/social-sign-in.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import {
	type AccountConnectionListItem,
	type AccountConnectionsLoaderData,
	type AccountProfileLoaderData,
	type ProfileVisibility,
} from '#app/loader-data.ts'
import { routes } from '#app/routes.ts'
import { UserAvatar } from '#app/user-avatar.tsx'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
	mutedLinkCss,
	primaryLinkCss,
	textareaCss,
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
} from '#client/routes/account-management-components.tsx'
import { renderOnboardingBanner } from '#client/routes/onboarding-banner.tsx'
import {
	renderEmailVerificationPrompt,
	requestResendVerification,
} from '#client/routes/email-verification-prompt.tsx'
import {
	fetchOnboardingPayload,
	type OnboardingPayload,
} from '#client/routes/onboarding.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

const emailChangeApiPath = '/account/email-change.json'
const connectionsApiPath = '/account/connections.json'
const accountAvatarApiPath = '/account/profile/avatar.json'

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
	const [profileResponse, connectionsResponse, onboarding] = await Promise.all([
		fetch(`${accountProfileApiPath}${url.search}`, {
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		}),
		fetch(connectionsApiPath, {
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		}),
		fetchOnboardingPayload(signal),
	])
	if (profileResponse.status === 401 || connectionsResponse.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const [payload, connectionsPayload] = await Promise.all([
		readJson<AccountProfileLoaderData>(profileResponse),
		readJson<AccountConnectionsLoaderData>(connectionsResponse),
	])
	if (!profileResponse.ok || !payload?.ok) {
		throw new Error('Unable to load your account.')
	}
	if (!connectionsResponse.ok || !connectionsPayload?.ok) {
		throw new Error('Unable to load connected accounts.')
	}
	return {
		accountProfile: payload,
		accountConnections: connectionsPayload,
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
	let draftDisplayName = ''
	let draftBio = ''
	let draftProfileVisibility: ProfileVisibility = 'public'
	let savedDisplayName = ''
	let savedBio = ''
	let savedProfileVisibility: ProfileVisibility = 'public'
	let avatarUrl: string | null = null
	let avatarStatus: 'idle' | 'uploading' | 'removing' = 'idle'
	let draftEmail = ''
	let emailChangePassword = ''
	let message: string | null = null
	let messageTone: 'error' | 'info' = 'info'
	let emailChangeMessage: string | null = null
	let emailChangeTone: 'error' | 'info' = 'info'
	let connectionsBusy = false
	let connections: Array<AccountConnectionListItem> = []
	let canDisconnect = true
	let availableProviders: Array<{ id: string; label: string }> = []
	let connectionsMessage: { text: string; tone: 'error' | 'info' } | null = null
	let consumedCallbackMessage = false
	let needsOnboarding = false
	const loadLatch = createRouteLoadLatch()

	function applyConnectionsPayload(payload: AccountConnectionsLoaderData) {
		connections = payload.connections
		canDisconnect = payload.canDisconnect
		availableProviders = payload.availableProviders
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
				AccountConnectionsLoaderData & { error?: string }
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
			const [response, connectionsResponse, onboarding] = await Promise.all([
				fetch(`${accountProfileApiPath}${search}`, {
					headers: { Accept: 'application/json' },
					credentials: 'include',
					signal,
				}),
				fetch(connectionsApiPath, {
					headers: { Accept: 'application/json' },
					credentials: 'include',
					signal,
				}),
				fetchOnboardingPayload(signal),
			])
			if (signal.aborted) return
			if (response.status === 401 || connectionsResponse.status === 401) {
				window.location.assign('/login')
				return
			}
			const [payload, connectionsPayload] = await Promise.all([
				readJson<AccountProfileLoaderData>(response),
				readJson<AccountConnectionsLoaderData>(connectionsResponse),
			])
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load your account.')
			}
			if (!connectionsResponse.ok || !connectionsPayload?.ok) {
				throw new Error('Unable to load connected accounts.')
			}
			applyOnboardingPayload(onboarding)
			applyConnectionsPayload(connectionsPayload)
			email = payload.email
			emailVerified = payload.emailVerified
			username = payload.username
			draftUsername = payload.username
			applyProfileFields(payload)
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

	function applyProfileFields(payload: AccountProfileLoaderData) {
		savedDisplayName = payload.displayName
		savedBio = payload.bio ?? ''
		savedProfileVisibility = payload.profileVisibility
		draftDisplayName = payload.displayName
		draftBio = payload.bio ?? ''
		draftProfileVisibility = payload.profileVisibility
		avatarUrl = payload.avatarUrl
	}

	async function handleAvatarSelected(event: Event) {
		const input = event.currentTarget
		if (!(input instanceof HTMLInputElement) || !input.files?.[0]) return
		const file = input.files[0]
		avatarStatus = 'uploading'
		message = null
		messageTone = 'info'
		handle.update()

		try {
			const body = new FormData()
			body.set('avatar', file)
			const response = await fetch(accountAvatarApiPath, {
				method: 'POST',
				headers: { Accept: 'application/json' },
				credentials: 'include',
				body,
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountProfileLoaderData & { error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to upload avatar.')
			}
			applyProfileFields(payload)
			message = 'Avatar updated.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to upload avatar.'
			messageTone = 'error'
		} finally {
			avatarStatus = 'idle'
			input.value = ''
			handle.update()
		}
	}

	async function handleRemoveAvatar() {
		avatarStatus = 'removing'
		message = null
		messageTone = 'info'
		handle.update()

		try {
			const response = await fetch(accountAvatarApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ remove: true }),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountProfileLoaderData & { error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to remove avatar.')
			}
			applyProfileFields(payload)
			message = 'Avatar removed.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to remove avatar.'
			messageTone = 'error'
		} finally {
			avatarStatus = 'idle'
			handle.update()
		}
	}

	async function handleResendVerification() {
		resendStatus = 'sending'
		resendMessage = null
		resendTone = 'info'
		handle.update()

		try {
			const result = await requestResendVerification()
			if (!result.ok && result.unauthorized) {
				window.location.assign('/login')
				return
			}
			resendTone = result.ok ? 'info' : 'error'
			resendMessage = result.message
		} catch {
			resendTone = 'error'
			resendMessage = 'Unable to send the verification email.'
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

	async function handleProfileSubmit(event: SubmitEvent) {
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
				body: JSON.stringify({
					username: nextUsername,
					displayName: draftDisplayName,
					bio: draftBio,
					profileVisibility: draftProfileVisibility,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountProfileLoaderData & {
					error?: string
					packagesUpdated?: number
					communityListingsRepublished?: number
					packageUpdateMessage?: string
					communityUpdateWarning?: string
				}
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to save profile.')
			}
			email = payload.email
			emailVerified = payload.emailVerified
			username = payload.username
			draftUsername = payload.username
			applyProfileFields(payload)
			const packageMessage =
				typeof payload.packageUpdateMessage === 'string'
					? payload.packageUpdateMessage
					: null
			const communityWarning =
				typeof payload.communityUpdateWarning === 'string'
					? payload.communityUpdateWarning
					: null
			message = ['Profile saved.', packageMessage, communityWarning]
				.filter(Boolean)
				.join(' ')
			messageTone = communityWarning ? 'error' : 'info'
			queueSessionRefresh()
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to save profile.'
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
		const connectionsData = tryConsumeRouteLoaderData(
			handle,
			'accountConnections',
			href,
		)
		if (!connectionsData) return false
		email = routeData.email
		emailVerified = routeData.emailVerified
		username = routeData.username
		draftUsername = routeData.username
		applyProfileFields(routeData)
		draftEmail = routeData.email
		applyConnectionsPayload(connectionsData)
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
		// Apply the OAuth flash on both SSR and client from the URL so the
		// first client render matches the server HTML. A client-only message
		// mismatched SSR and duplicated the connections list during hydration.
		if (!consumedCallbackMessage) {
			consumedCallbackMessage = true
			connectionsMessage =
				readConnectionCallbackMessage(currentHref) ?? connectionsMessage
		}
		const isSaving = saveStatus === 'saving'
		const isSendingEmailChange = emailChangeStatus === 'sending'
		const normalizedDraftUsername = draftUsername.trim().toLowerCase()
		const normalizedDraftEmail = draftEmail.trim().toLowerCase()
		const profileUnchanged =
			normalizedDraftUsername === username &&
			draftDisplayName === savedDisplayName &&
			draftBio === savedBio &&
			draftProfileVisibility === savedProfileVisibility

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Account"
					description="Manage your profile, security settings, connected accounts, and data export."
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
						{!emailVerified
							? renderEmailVerificationPrompt({
									description:
										'Check your inbox for the verification link. MCP access and email features stay locked until this account email is verified.',
									resendStatus,
									resendMessage,
									resendTone,
									onResend: () => {
										void handleResendVerification()
									},
									secondaryHref: '/pending-verification',
									secondaryLabel: 'Verification page',
								})
							: null}
						{emailVerified && needsOnboarding ? renderOnboardingBanner() : null}
						<AccountManagementPanel
							title="Profile"
							description="Your username is unique. Display name, bio, avatar, and visibility control your public community profile."
						>
							<form
								mix={[
									css({ display: 'grid', gap: spacing.md }),
									on('submit', handleProfileSubmit),
								]}
							>
								<div mix={css(avatarSectionCss)} data-testid="account-avatar">
									<UserAvatar
										displayName={draftDisplayName || username}
										avatarUrl={avatarUrl}
										size={72}
										testId="account-avatar-image"
									/>
									<div mix={css({ display: 'grid', gap: spacing.sm })}>
										<label mix={css(fieldCss)}>
											<span mix={css(fieldLabelCss)}>Avatar</span>
											<input
												type="file"
												name="avatar"
												accept="image/png,image/jpeg,image/webp"
												disabled={avatarStatus !== 'idle' || isSaving}
												mix={[
													css(inputCss),
													on('change', (event) => {
														void handleAvatarSelected(event)
													}),
												]}
											/>
										</label>
										{avatarUrl ? (
											<button
												type="button"
												disabled={avatarStatus !== 'idle' || isSaving}
												mix={[
													css(secondaryButtonCss),
													on('click', () => {
														void handleRemoveAvatar()
													}),
												]}
											>
												{avatarStatus === 'removing'
													? 'Removing...'
													: 'Remove avatar'}
											</button>
										) : null}
										{avatarStatus === 'uploading' ? (
											<p mix={css(descriptionCss)}>Uploading avatar…</p>
										) : null}
									</div>
								</div>
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
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Display name</span>
									<input
										type="text"
										name="displayName"
										maxLength={50}
										autoComplete="nickname"
										value={draftDisplayName}
										mix={[
											css(inputCss),
											on('input', (event) => {
												draftDisplayName = (
													event.currentTarget as HTMLInputElement
												).value
												handle.update()
											}),
										]}
									/>
								</label>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Bio</span>
									<textarea
										name="bio"
										maxLength={500}
										rows={3}
										value={draftBio}
										mix={[
											css(textareaCss),
											on('input', (event) => {
												draftBio = (event.currentTarget as HTMLTextAreaElement)
													.value
												handle.update()
											}),
										]}
									/>
								</label>
								<fieldset mix={css({ margin: 0, padding: 0, border: 'none' })}>
									<legend mix={css(fieldLabelCss)}>Profile visibility</legend>
									<label
										mix={css({
											display: 'flex',
											gap: spacing.sm,
											alignItems: 'center',
											marginTop: spacing.sm,
										})}
									>
										<input
											type="radio"
											name="profileVisibility"
											checked={draftProfileVisibility === 'public'}
											mix={[
												on('change', () => {
													draftProfileVisibility = 'public'
													handle.update()
												}),
											]}
										/>
										<span>Public</span>
									</label>
									<label
										mix={css({
											display: 'flex',
											gap: spacing.sm,
											alignItems: 'center',
											marginTop: spacing.xs,
										})}
									>
										<input
											type="radio"
											name="profileVisibility"
											checked={draftProfileVisibility === 'private'}
											mix={[
												on('change', () => {
													draftProfileVisibility = 'private'
													handle.update()
												}),
											]}
										/>
										<span>Private</span>
									</label>
									<p mix={css(descriptionCss)}>
										Private hides your profile, public package list, and
										activity from others.
									</p>
								</fieldset>
								<p mix={css({ color: colors.textMuted, margin: 0 })}>
									Email: {email} ({emailVerified ? 'verified' : 'unverified'})
								</p>
								<p mix={css({ margin: 0 })}>
									<a
										href={routes.profile.href({ username })}
										mix={css(mutedLinkCss)}
									>
										View public profile
									</a>
								</p>
								{normalizedDraftUsername !== username ? (
									<p mix={css({ color: colors.textMuted, margin: 0 })}>
										Changing your username updates every saved package to the
										new <code>@{normalizedDraftUsername}</code> scope with an
										automatic commit. That can affect third-party integrations
										and dynamic invocations that still reference{' '}
										<code>@{username}</code>. Community listings already pinned
										to the latest package commit are republished automatically.
									</p>
								) : null}
								<div>
									<button
										type="submit"
										disabled={isSaving || profileUnchanged}
										mix={css(primaryButtonCss)}
									>
										{isSaving ? 'Saving...' : 'Save profile'}
									</button>
								</div>
							</form>
							<form
								{...passwordManagerIgnoreProps}
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
										{...passwordManagerIgnoreProps}
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
												key={provider.id}
												type="button"
												disabled={connectionsBusy}
												mix={[
													css(providerConnectButtonCss),
													on('click', () => handleConnectProvider(provider.id)),
												]}
											>
												<ProviderIcon providerId={provider.id} />
												Connect {provider.label}
											</button>
										))}
									</div>
								) : null}
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

const avatarSectionCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.md,
	flexWrap: 'wrap' as const,
}

const providerConnectButtonCss = {
	...secondaryButtonCss,
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: spacing.sm,
}
