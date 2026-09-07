import { type Handle, css } from 'remix/ui'
import { listenForAvatarFileDrop } from '#client/listen-for-avatar-file-drop.ts'
import { AccountAvatarEditor } from '#client/routes/account-avatar-editor.tsx'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import {
	type OnboardingChecklistLoaderData,
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
	interpretAccountProfileSave,
	readProfileFormValues,
	usernameFormatError,
} from '#client/routes/account-profile-save.ts'
import {
	type AccountStatus,
	accountProfileApiPath,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import { fetchAccountPagePayloads } from '#client/routes/account-page-data.ts'
import { AccountDeletePanel } from '#client/routes/account-delete-panel.tsx'
import { renderAccountLogoutPanel } from '#client/routes/account-logout-panel.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountActionsCss,
} from '#client/routes/account-management-components.tsx'
import { createAccountEmailClaims } from '#client/routes/account-email-claims-client.ts'
import { renderAccountFormerEmailsPanel } from '#client/routes/account-former-emails-panel.tsx'
import { renderAccountProfilePanel } from '#client/routes/account-profile-panel.tsx'
import { AccountPasswordPanel } from '#client/routes/account-password-panel.tsx'
import {
	createAccountConnections,
	readConnectionCallbackMessage,
} from '#client/routes/account-connections-panel.tsx'
import { createAccountConnectedAgents } from '#client/routes/account-connected-agents-panel.tsx'
import { renderOnboardingBanner } from '#client/routes/onboarding-banner.tsx'
import { shouldShowOnboardingChecklist } from '#client/routes/onboarding-checklist.tsx'
import {
	renderEmailVerificationPrompt,
	requestResendVerification,
} from '#client/routes/email-verification-prompt.tsx'
import { type OnboardingPayload } from '#client/routes/onboarding-payload.ts'

const accountAvatarApiPath = '/account/profile/avatar.json'

export { accountRouteLoader } from '#client/routes/account-page-data.ts'

function isAccountPath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/account'
}

export function AccountRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let saveStatus: 'idle' | 'saving' = 'idle'
	let resendStatus: 'idle' | 'sending' = 'idle'
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
	let message: string | null = null
	let messageTone: 'error' | 'info' = 'info'
	let usernameSaveError: string | null = null
	const accountConnections = createAccountConnections(handle)
	const accountConnectedAgents = createAccountConnectedAgents(handle)
	const accountEmailClaims = createAccountEmailClaims(handle)
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
			const result = await fetchAccountPagePayloads(search, signal)
			if (signal.aborted) return
			if (result.kind === 'unauthorized') {
				window.location.assign('/login')
				return
			}
			const {
				accountProfile: payload,
				accountConnections: connectionsPayload,
				accountConnectedAgents: connectedAgentsPayload,
				onboarding,
			} = result.payloads
			applyOnboardingPayload(onboarding)
			accountConnections.applyPayload(connectionsPayload)
			accountConnectedAgents.applyPayload(connectedAgentsPayload)
			email = payload.email
			emailVerified = payload.emailVerified
			emailVerificationDelivery = payload.emailVerificationDelivery ?? null
			username = payload.username
			if (!usernameSaveError) {
				draftUsername = payload.username
				message = null
				messageTone = 'info'
			}
			applyProfileFields(payload)
			accountEmailClaims.applyCurrentEmail(payload.email)
			status = 'ready'
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
		accountEmailClaims.applyFormerEmails(payload.formerEmails ?? [])
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
		if (usernameSaveError) usernameSaveError = null
		handle.update()
	}

	async function handleProfileSubmit(event: SubmitEvent) {
		event.preventDefault()
		const submitted = readProfileFormValues(event.currentTarget, {
			username: draftUsername,
			displayName: draftDisplayName,
			bio: draftBio,
			profileVisibility: draftProfileVisibility,
		})
		draftUsername = submitted.username
		draftDisplayName = submitted.displayName
		draftBio = submitted.bio
		draftProfileVisibility = submitted.profileVisibility
		const nextUsername = submitted.username.trim()
		if (!nextUsername) {
			usernameSaveError = 'Username is required.'
			message = usernameSaveError
			messageTone = 'error'
			handle.update()
			return
		}

		const formatError = usernameFormatError(nextUsername)
		const usernameChangeRequested =
			nextUsername.toLowerCase() !== username.toLowerCase()
		if (formatError && usernameChangeRequested) {
			usernameSaveError = formatError
			message = formatError
			messageTone = 'error'
			handle.update()
			return
		}

		const profileFieldsChanged =
			submitted.displayName !== savedDisplayName ||
			submitted.bio !== savedBio ||
			submitted.profileVisibility !== savedProfileVisibility

		saveStatus = 'saving'
		message = null
		messageTone = 'info'
		usernameSaveError = null
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
					displayName: submitted.displayName,
					bio: submitted.bio,
					profileVisibility: submitted.profileVisibility,
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
			const result = interpretAccountProfileSave({
				previousUsername: username,
				requestedUsername: nextUsername,
				profileFieldsChanged,
				responseOk: response.ok,
				payload,
			})
			switch (result.status) {
				case 'error':
					usernameSaveError = usernameChangeRequested ? result.message : null
					message = result.message
					messageTone = 'error'
					toast.error(result.message)
					return
				case 'noop':
					message = null
					messageTone = 'info'
					return
				case 'saved':
					if (!payload) {
						throw new Error('Unable to save profile.')
					}
					email = payload.email
					emailVerified = payload.emailVerified
					emailVerificationDelivery = payload.emailVerificationDelivery ?? null
					username = payload.username
					if (result.usernameChanged) {
						draftUsername = payload.username
					}
					applyProfileFields(payload)
					message = result.message
					messageTone = payload.communityUpdateWarning ? 'error' : 'info'
					if (result.usernameChanged) {
						queueSessionRefresh()
					}
					return
				default: {
					const _exhaustive: never = result
					throw new Error(
						`Unhandled profile save status: ${String(_exhaustive)}`,
					)
				}
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unable to save profile.'
			if (usernameChangeRequested) usernameSaveError = errorMessage
			message = errorMessage
			messageTone = 'error'
			toast.error(errorMessage)
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
		if (!usernameSaveError) {
			draftUsername = routeData.username
			message = null
			messageTone = 'info'
		}
		applyProfileFields(routeData)
		accountEmailClaims.applyCurrentEmail(routeData.email)
		accountConnections.applyPayload(connectionsData)
		const connectedAgentsData = tryConsumeRouteLoaderData(
			handle,
			'accountConnectedAgents',
			href,
		)
		if (!connectedAgentsData) return false
		accountConnectedAgents.applyPayload(connectedAgentsData)
		const onboardingData = tryConsumeRouteLoaderData(handle, 'onboarding', href)
		if (onboardingData) {
			applyOnboardingPayload(onboardingData)
		}
		status = 'ready'
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
		const emailClaims = accountEmailClaims.snapshot
		const isSendingEmailChange = emailClaims.emailChangeStatus === 'sending'
		const normalizedDraftUsername = draftUsername.trim().toLowerCase()
		const normalizedDraftEmail = emailClaims.draftEmail.trim().toLowerCase()
		const profileUnchanged =
			normalizedDraftUsername === username &&
			draftDisplayName === savedDisplayName &&
			draftBio === savedBio &&
			draftProfileVisibility === savedProfileVisibility
		const liveUsernameFormatError =
			normalizedDraftUsername && normalizedDraftUsername !== username
				? usernameFormatError(draftUsername)
				: null
		const usernameFieldError = usernameSaveError ?? liveUsernameFormatError

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
							draftEmail: emailClaims.draftEmail,
							emailChangePassword: emailClaims.emailChangePassword,
							avatarUrl,
							avatarStatus,
							isSaving,
							isSendingEmailChange,
							profileUnchanged,
							normalizedDraftUsername,
							normalizedDraftEmail,
							emailChangeMessage: emailClaims.emailChangeMessage,
							emailChangeTone: emailClaims.emailChangeTone,
							emailChangeOpen: emailClaims.emailChangeOpen,
							usernameFieldError,
							onProfileSubmit: handleProfileSubmit,
							onEmailChangeSubmit: (event) => {
								void accountEmailClaims.handleEmailChangeSubmit(event, email)
							},
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
							onDraftEmailInput: accountEmailClaims.updateDraftEmail,
							onEmailChangePasswordInput:
								accountEmailClaims.updateEmailChangePassword,
						})}
						{emailVerified
							? renderAccountFormerEmailsPanel({
									formerEmails: emailClaims.formerEmails,
									releaseEmail: emailClaims.releaseEmail,
									releasePassword: emailClaims.releasePassword,
									releaseStatus: emailClaims.releaseStatus,
									releaseMessage: emailClaims.releaseMessage,
									releaseTone: emailClaims.releaseTone,
									onReleaseEmailInput: accountEmailClaims.updateReleaseEmail,
									onReleasePasswordInput:
										accountEmailClaims.updateReleasePassword,
									onReleaseSubmit:
										accountEmailClaims.handleFormerEmailReleaseSubmit,
									onUseAgainAsLogin: accountEmailClaims.useFormerEmailAsLogin,
									onReleaseListed: (listedEmail) => {
										void accountEmailClaims.requestFormerEmailRelease(
											listedEmail,
										)
									},
								})
							: null}
						<AccountPasswordPanel
							hasUsablePassword={accountConnections.hasUsablePassword}
							onPasswordSet={() => {
								accountConnections.markHasUsablePassword()
							}}
						/>
						{accountConnections.render()}
						{accountConnectedAgents.render()}
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
							description="Optional tools for hosts that cannot finish dynamic OAuth on their own. This is not the list of agents already connected to your account."
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

				{renderAccountLogoutPanel()}

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
