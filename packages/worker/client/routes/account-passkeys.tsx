import {
	formatNullableTimestamp,
	formatTimestamp,
} from '#client/format-timestamp.ts'
import { startRegistration } from '@simplewebauthn/browser'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from '#client/routes/account-management-components.tsx'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
	layoutMaxWidths,
	primaryLinkCss,
} from '#client/styles/style-primitives.ts'

type PasskeyListItem = {
	id: string
	name: string
	deviceType: string
	backedUp: boolean
	createdAt: string
	lastUsedAt: string | null
}

type AccountPasskeysPayload = {
	ok: true
	passkeys: Array<PasskeyListItem>
}

const passkeysApiPath = '/account/passkeys.json'
const passkeysPath = '/account/passkeys'
const webauthnRegistrationPath = '/webauthn/registration'

function isPasskeysPath(href: string) {
	return new URL(href, 'http://localhost').pathname === passkeysPath
}

export async function accountPasskeysRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(passkeysApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountPasskeysPayload>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load passkeys.')
	}
	return { accountPasskeys: payload }
}

function describeDeviceType(deviceType: string) {
	return deviceType === 'multiDevice'
		? 'Synced passkey'
		: 'Device-bound passkey'
}

export function AccountPasskeysRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let actionStatus: 'idle' | 'busy' = 'idle'
	let passkeys: Array<PasskeyListItem> = []
	let message: string | null = null
	let messageTone: 'error' | 'info' = 'info'
	let renamingPasskeyId: string | null = null
	let renameDraft = ''
	const loadLatch = createRouteLoadLatch()

	async function loadPasskeys(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		try {
			const response = await fetch(passkeysApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountPasskeysPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load passkeys.')
			}
			passkeys = payload.passkeys
			status = 'ready'
			message = null
			messageTone = 'info'
			loadLatch.markLoaded(href)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load passkeys.'
			messageTone = 'error'
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	async function handleRegisterPasskey() {
		actionStatus = 'busy'
		message = null
		handle.update()

		try {
			const optionsResponse = await fetch(webauthnRegistrationPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (optionsResponse.status === 401) {
				window.location.assign('/login')
				return
			}
			const optionsPayload = await readJson<{
				ok?: boolean
				options?: Parameters<typeof startRegistration>[0]['optionsJSON']
				error?: string
			}>(optionsResponse)
			if (
				!optionsResponse.ok ||
				!optionsPayload?.ok ||
				!optionsPayload.options
			) {
				throw new Error(
					optionsPayload?.error || 'Unable to start passkey registration.',
				)
			}

			const registrationResponse = await startRegistration({
				optionsJSON: optionsPayload.options,
			})

			const verificationResponse = await fetch(webauthnRegistrationPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ response: registrationResponse }),
			})
			if (verificationResponse.status === 401) {
				window.location.assign('/login')
				return
			}
			const verificationPayload = await readJson<{
				ok?: boolean
				error?: string
			}>(verificationResponse)
			if (!verificationResponse.ok || !verificationPayload?.ok) {
				throw new Error(
					verificationPayload?.error || 'Unable to register the passkey.',
				)
			}

			message = 'Passkey registered.'
			messageTone = 'info'
			await refreshPasskeys()
		} catch (error) {
			message =
				error instanceof Error && error.name === 'NotAllowedError'
					? 'Passkey registration was cancelled.'
					: error instanceof Error
						? error.message
						: 'Unable to register the passkey.'
			messageTone = 'error'
		} finally {
			actionStatus = 'idle'
			handle.update()
		}
	}

	async function refreshPasskeys() {
		const response = await fetch(passkeysApiPath, {
			headers: { Accept: 'application/json' },
			credentials: 'include',
		})
		const payload = await readJson<AccountPasskeysPayload>(response)
		if (response.ok && payload?.ok) {
			passkeys = payload.passkeys
		}
	}

	function beginRename(passkey: PasskeyListItem) {
		renamingPasskeyId = passkey.id
		renameDraft = passkey.name
		message = null
		handle.update()
	}

	function cancelRename() {
		renamingPasskeyId = null
		renameDraft = ''
		handle.update()
	}

	async function handleRenamePasskey(passkeyId: string) {
		actionStatus = 'busy'
		message = null
		handle.update()

		try {
			const response = await fetch(passkeysApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					intent: 'rename',
					passkeyId,
					name: renameDraft,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountPasskeysPayload & { error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to rename the passkey.')
			}
			passkeys = payload.passkeys
			renamingPasskeyId = null
			renameDraft = ''
			message = 'Passkey renamed.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to rename the passkey.'
			messageTone = 'error'
		} finally {
			actionStatus = 'idle'
			handle.update()
		}
	}

	async function handleDeletePasskey(passkeyId: string) {
		actionStatus = 'busy'
		message = null
		handle.update()

		try {
			const response = await fetch(passkeysApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ intent: 'delete', passkeyId }),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountPasskeysPayload & { error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to delete the passkey.')
			}
			passkeys = payload.passkeys
			if (renamingPasskeyId === passkeyId) {
				renamingPasskeyId = null
				renameDraft = ''
			}
			message = 'Passkey deleted.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to delete the passkey.'
			messageTone = 'error'
		} finally {
			actionStatus = 'idle'
			handle.update()
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!isPasskeysPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'accountPasskeys', href)
		if (!routeData) return false
		passkeys = routeData.passkeys
		status = 'ready'
		message = null
		messageTone = 'info'
		loadLatch.markLoaded(href)
		return true
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadPasskeys)
		}
		const isBusy = actionStatus === 'busy'

		return (
			<AccountManagementShell maxWidth={layoutMaxWidths.content}>
				<AccountPageHeader
					title="Passkeys"
					description="Sign in with your device's screen lock, a hardware key, or a synced passkey instead of your password."
					currentHref={currentHref}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading passkeys…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' ? (
					<>
						<section mix={css(cardCss)}>
							<h2 mix={css(cardTitleCss)}>Register a passkey</h2>
							<p mix={css(descriptionCss)}>
								Your browser will prompt you to create a passkey with your
								device. Passkey sign-in skips the two-factor code because the
								passkey itself already satisfies multi-factor authentication.
							</p>
							<div>
								<button
									type="button"
									disabled={isBusy}
									mix={[
										css(primaryButtonCss),
										on('click', handleRegisterPasskey),
									]}
								>
									{isBusy ? 'Working...' : 'Register a passkey'}
								</button>
							</div>
						</section>

						{passkeys.length === 0 ? (
							<section mix={css(cardCss)}>
								<h2 mix={css(cardTitleCss)}>No passkeys yet</h2>
								<p mix={css(descriptionCss)}>
									Registered passkeys appear here. You can sign in with a
									passkey from the login page.
								</p>
							</section>
						) : (
							<section mix={css(cardCss)} aria-label="Registered passkeys">
								<h2 mix={css(cardTitleCss)}>Registered passkeys</h2>
								<ul
									mix={css({
										listStyle: 'none',
										padding: 0,
										margin: 0,
										display: 'grid',
										gap: spacing.md,
									})}
								>
									{passkeys.map((passkey) => {
										const isRenaming = renamingPasskeyId === passkey.id
										return (
											<li
												key={passkey.id}
												mix={css({
													display: 'flex',
													justifyContent: 'space-between',
													alignItems: 'flex-start',
													gap: spacing.md,
													flexWrap: 'wrap',
													paddingBottom: spacing.md,
													borderBottom: `1px solid ${colors.border}`,
												})}
											>
												<div
													mix={css({
														display: 'grid',
														gap: spacing.xs,
														flex: '1 1 16rem',
														minWidth: 0,
													})}
												>
													{isRenaming ? (
														<label
															mix={css({
																display: 'grid',
																gap: spacing.xs,
															})}
														>
															<span
																mix={css({
																	fontSize: typography.fontSize.sm,
																	color: colors.textMuted,
																})}
															>
																Nickname
															</span>
															<input
																type="text"
																value={renameDraft}
																maxLength={80}
																disabled={isBusy}
																aria-label="Passkey nickname"
																mix={[
																	css(inputCss),
																	on('input', (event) => {
																		renameDraft = (
																			event.currentTarget as HTMLInputElement
																		).value
																		handle.update()
																	}),
																]}
															/>
														</label>
													) : (
														<span
															mix={css({
																fontWeight: typography.fontWeight.medium,
																color: colors.text,
															})}
														>
															{passkey.name}
														</span>
													)}
													<span
														mix={css({
															color: colors.textMuted,
															fontSize: typography.fontSize.sm,
														})}
													>
														{describeDeviceType(passkey.deviceType)}
													</span>
													<span
														mix={css({
															color: colors.textMuted,
															fontSize: typography.fontSize.sm,
														})}
													>
														Created {formatTimestamp(passkey.createdAt)}
													</span>
													<span
														mix={css({
															color: colors.textMuted,
															fontSize: typography.fontSize.sm,
														})}
													>
														Last used{' '}
														{formatNullableTimestamp(
															passkey.lastUsedAt,
															'Never',
														)}
													</span>
												</div>
												<div
													mix={css({
														display: 'flex',
														gap: spacing.sm,
														flexWrap: 'wrap',
													})}
												>
													{isRenaming ? (
														<>
															<button
																type="button"
																disabled={isBusy}
																mix={[
																	css(primaryButtonCss),
																	on('click', () =>
																		handleRenamePasskey(passkey.id),
																	),
																]}
															>
																Save
															</button>
															<button
																type="button"
																disabled={isBusy}
																mix={[
																	css(secondaryButtonCss),
																	on('click', cancelRename),
																]}
															>
																Cancel
															</button>
														</>
													) : (
														<button
															type="button"
															disabled={isBusy}
															mix={[
																css(secondaryButtonCss),
																on('click', () => beginRename(passkey)),
															]}
														>
															Rename
														</button>
													)}
													<button
														type="button"
														disabled={isBusy}
														mix={[
															css(dangerButtonCss),
															on('click', () =>
																handleDeletePasskey(passkey.id),
															),
														]}
													>
														Delete
													</button>
												</div>
											</li>
										)
									})}
								</ul>
							</section>
						)}
					</>
				) : null}

				<p mix={css({ margin: 0 })}>
					<a href="/account" mix={css(primaryLinkCss)}>
						Back to account
					</a>
				</p>
			</AccountManagementShell>
		)
	}
}

const primaryButtonCss = getPrimaryButtonCss()
const secondaryButtonCss = getSecondaryButtonCss()
const dangerButtonCss = getDangerButtonCss()
