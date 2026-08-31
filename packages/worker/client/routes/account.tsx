import { type Handle, css } from 'remix/ui'
import { listenForAvatarFileDrop } from '#client/listen-for-avatar-file-drop.ts'
import { AccountAvatarEditor } from '#client/routes/account-avatar-editor.tsx'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import {
	type OnboardingChecklistLoaderData,
	type AccountConnectionsLoaderData,
	type AccountProfileLoaderData,
	type ProfileVisibility,
} from '#universal/loader-data.ts'
import { acceptedEmailVerificationDelivery } from '#universal/email-verification-delivery.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	mutedLinkCss,
} from '#universal/styles/style-primitives.ts'
import { queueSessionRefresh } from '#client/session.ts'
import { toast } from '#client/toast.ts'
import {
	type AccountStatus,
	accountProfileApiPath,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import { AccountDeletePanel } from '#client/routes/account-delete-panel.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountActionsCss,
} from '#client/routes/account-management-components.tsx'
import { renderAccountProfilePanel } from '#client/routes/account-profile-panel.tsx'
import {
	createAccountConnections,
	readConnectionCallbackMessage,
} from '#client/routes/account-connections-panel.tsx'
import { renderOnboardingBanner } from '#client/routes/onboarding-banner.tsx'
import { shouldShowOnboardingChecklist } from '#client/routes/onboarding-checklist.tsx'
import {
	renderEmailVerificationPrompt,
	requestResendVerification,
} from '#client/routes/email-verification-prompt.tsx'
import {
	fetchOnboardingPayload,
	type OnboardingPayload,
} from '#client/routes/onboarding-payload.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

const emailChangeApiPath = '/account/email-change.json'
const connectionsApiPath = '/account/connections.json'
const accountAvatarApiPath = '/account/profile/avatar.json'

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
	let emailVerificationDelivery: AccountProfileLoaderData['emailVerificationDelivery'] =
		null
	let username = ''
	let draftUsername = ''
	let draftDisplayName = ''
	let draftBio = ''
	let draftProfileVisibility: ProfileVisibility = 'public'
	let savedDisplayName = ''
	let savedBio = ''
	let savedProfileVisibility: ProfileVisibility = 'public'
	let avatarUrl: string | null = null
	let optimisticAvatarObjectUrl: string | null = null
	let avatarStatus: 'idle' | 'editing' | 'uploading' | 'removing' = 'idle'
	let editorFile: File | null = null
	let avatarDropActive = false
	let draftEmail = ''
	let emailChangePassword = ''
	let message: string | null = null
	let messageTone: 'error' | 'info' = 'info'
	let emailChangeMessage: string | null = null
	let emailChangeTone: 'error' | 'info' = 'info'
	const accountConnections = createAccountConnections(handle)
	let consumedCallbackMessage = false
	let needsOnboarding = false
	let onboardingChecklist: OnboardingChecklistLoaderData | null = null
	const loadLatch = createRouteLoadLatch()

	function applyOnboardingPayload(payload: OnboardingPayload | null) {
		needsOnboarding = payload?.needsOnboarding === true
		onboardingChecklist = payload?.checklist ?? null
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
			accountConnections.applyPayload(connectionsPayload)
			email = payload.email
			emailVerified = payload.emailVerified
			emailVerificationDelivery = payload.emailVerificationDelivery ?? null
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
		if (!optimisticAvatarObjectUrl) avatarUrl = payload.avatarUrl
	}

	function releaseOptimisticAvatar() {
		if (!optimisticAvatarObjectUrl) return
		URL.revokeObjectURL(optimisticAvatarObjectUrl)
		optimisticAvatarObjectUrl = null
	}

	if (typeof document !== 'undefined') {
		listenForAvatarFileDrop({
			signal: handle.signal,
			onDragActiveChange(active) {
				avatarDropActive = active
				handle.update()
			},
			onImageFile(file) {
				openAvatarEditor(file)
			},
		})
	}

	handle.signal.addEventListener(
		'abort',
		() => {
			releaseOptimisticAvatar()
		},
		{ once: true },
	)

	function openAvatarEditor(file: File) {
		if (avatarStatus !== 'idle' && avatarStatus !== 'editing') return
		editorFile = file
		avatarStatus = 'editing'
		message = null
		messageTone = 'info'
		handle.update()
	}

	function closeAvatarEditor() {
		editorFile = null
		if (avatarStatus === 'editing') avatarStatus = 'idle'
		handle.update()
	}

	function setAvatarEditorBusy(busy: boolean) {
		if (busy) {
			avatarStatus = 'uploading'
		} else if (editorFile) {
			avatarStatus = 'editing'
		}
		handle.update()
	}

	async function uploadPreparedAvatar(prepared: File) {
		editorFile = null
		const previousAvatarUrl = avatarUrl
		releaseOptimisticAvatar()
		optimisticAvatarObjectUrl = URL.createObjectURL(prepared)
		avatarUrl = optimisticAvatarObjectUrl
		avatarStatus = 'uploading'
		handle.update()

		try {
			const body = new FormData()
			body.set('avatar', prepared)
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
			releaseOptimisticAvatar()
			applyProfileFields(payload)
			toast.success('Avatar updated.')
		} catch (error) {
			releaseOptimisticAvatar()
			avatarUrl = previousAvatarUrl
			toast.error(
				error instanceof Error ? error.message : 'Unable to upload avatar.',
			)
		} finally {
			avatarStatus = 'idle'
			handle.update()
		}
	}

	function handleAvatarSelected(event: Event) {
		const input = event.currentTarget
		if (!(input instanceof HTMLInputElement) || !input.files?.[0]) return
		try {
			openAvatarEditor(input.files[0])
		} finally {
			input.value = ''
		}
	}

	async function handleRemoveAvatar() {
		const previousAvatarUrl = avatarUrl
		releaseOptimisticAvatar()
		avatarUrl = null
		avatarStatus = 'removing'
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
			toast.success('Avatar removed.')
		} catch (error) {
			avatarUrl = previousAvatarUrl
			toast.error(
				error instanceof Error ? error.message : 'Unable to remove avatar.',
			)
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
			if (result.ok) {
				emailVerificationDelivery = acceptedEmailVerificationDelivery()
			}
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
			emailVerificationDelivery = payload.emailVerificationDelivery ?? null
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
		emailVerificationDelivery = routeData.emailVerificationDelivery ?? null
		username = routeData.username
		draftUsername = routeData.username
		applyProfileFields(routeData)
		draftEmail = routeData.email
		accountConnections.applyPayload(connectionsData)
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
			accountConnections.setMessage(readConnectionCallbackMessage(currentHref))
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
					description="Manage your profile, security settings, connected accounts, and data."
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
									delivery: emailVerificationDelivery,
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
						{emailVerified &&
						(needsOnboarding ||
							shouldShowOnboardingChecklist(onboardingChecklist))
							? renderOnboardingBanner({ checklist: onboardingChecklist })
							: null}
						{renderAccountProfilePanel({
							email,
							emailVerified,
							username,
							draftUsername,
							draftDisplayName,
							draftBio,
							draftProfileVisibility,
							draftEmail,
							emailChangePassword,
							avatarUrl,
							avatarStatus,
							isSaving,
							isSendingEmailChange,
							profileUnchanged,
							normalizedDraftUsername,
							normalizedDraftEmail,
							emailChangeMessage,
							emailChangeTone,
							onProfileSubmit: handleProfileSubmit,
							onEmailChangeSubmit: handleEmailChangeSubmit,
							onAvatarSelected: handleAvatarSelected,
							onRemoveAvatar: () => void handleRemoveAvatar(),
							onDraftUsernameInput: updateDraftUsername,
							onDraftDisplayNameChange: (value) => {
								draftDisplayName = value
								handle.update()
							},
							onDraftBioChange: (value) => {
								draftBio = value
								handle.update()
							},
							onDraftProfileVisibilityChange: (value) => {
								draftProfileVisibility = value
								handle.update()
							},
							onDraftEmailInput: updateDraftEmail,
							onEmailChangePasswordInput: updateEmailChangePassword,
						})}
						<AccountManagementPanel
							title="Security"
							description="Protect your account with two-factor authentication, or sign in without a password using passkeys."
						>
							<div mix={css(accountActionsCss)}>
								<a href="/account/two-factor" mix={css(compactGhostButtonCss)}>
									Two-factor authentication
								</a>
								<a href="/account/passkeys" mix={css(compactGhostButtonCss)}>
									Passkeys
								</a>
							</div>
						</AccountManagementPanel>
						{accountConnections.render()}
						<AccountManagementPanel
							title="Your data"
							description="Download a portable JSON export of your Kody account data for backup or migration. Secret values are never included; secret entries export metadata such as names, hosts, and allowlists only."
						>
							<div>
								<a
									href="/account/export.json"
									download="kody-account-export.json"
									mix={css(compactGhostButtonCss)}
								>
									Download account export
								</a>
							</div>
						</AccountManagementPanel>
						<AccountManagementPanel
							title="Advanced"
							description="Optional tools for hosts that cannot finish dynamic OAuth on their own."
						>
							<div mix={css(accountActionsCss)}>
								<a
									href="/account/mcp-oauth-clients"
									mix={css(compactGhostButtonCss)}
								>
									MCP OAuth clients
								</a>
							</div>
						</AccountManagementPanel>
						<AccountManagementPanel
							title="Delete account"
							description="Permanently delete this Kody account and every isolated store attached to it. This cannot be undone."
						>
							<AccountDeletePanel
								hasUsablePassword={accountConnections.hasUsablePassword}
							/>
						</AccountManagementPanel>
					</>
				) : null}

				<AccountAvatarEditor
					file={editorFile}
					onCancel={closeAvatarEditor}
					onBusyChange={setAvatarEditorBusy}
					onApply={(prepared) => {
						void uploadPreparedAvatar(prepared)
					}}
				/>
				{avatarDropActive ? (
					<div
						role="status"
						data-testid="account-avatar-drop-overlay"
						mix={css({
							position: 'fixed',
							inset: 0,
							zIndex: 2000,
							display: 'grid',
							placeItems: 'center',
							backgroundColor:
								'color-mix(in srgb, var(--color-background) 72%, transparent)',
							pointerEvents: 'none',
						})}
					>
						<p
							mix={css({
								margin: 0,
								padding: `${spacing.md} ${spacing.lg}`,
								border: `2px dashed ${colors.primary}`,
								borderRadius: radius.lg,
								backgroundColor: colors.surface,
								color: colors.text,
								fontWeight: typography.fontWeight.semibold,
							})}
						>
							Drop to set your avatar
						</p>
					</div>
				) : null}
				<p mix={css({ margin: 0 })}>
					<a href="/privacy" mix={css(mutedLinkCss)}>
						Privacy
					</a>
					{' · '}
					<a href="/terms" mix={css(mutedLinkCss)}>
						Terms
					</a>
				</p>
			</AccountManagementShell>
		)
	}
}

const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })
