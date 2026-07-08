import { toDataURL } from 'qrcode'
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
	AccountManagementHeader,
	AccountManagementMessage,
	AccountManagementShell,
} from '#client/routes/account-management-components.tsx'
import { colors, radius, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
	layoutMaxWidths,
	primaryLinkCss,
} from '#client/styles/style-primitives.ts'

type AccountTwoFactorPayload = {
	ok: true
	enabled: boolean
}

type TwoFactorSetup = {
	otpUri: string
	secret: string
	qrCodeDataUrl: string | null
}

const twoFactorApiPath = '/account/two-factor.json'
const twoFactorPath = '/account/two-factor'

function isTwoFactorPath(href: string) {
	return new URL(href, 'http://localhost').pathname === twoFactorPath
}

export async function accountTwoFactorRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(twoFactorApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountTwoFactorPayload>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load two-factor status.')
	}
	return { accountTwoFactor: payload }
}

export function AccountTwoFactorRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let actionStatus: 'idle' | 'busy' = 'idle'
	let enabled = false
	let setup: TwoFactorSetup | null = null
	let confirmCode = ''
	let disableCode = ''
	let message: string | null = null
	let messageTone: 'error' | 'info' = 'info'
	const loadLatch = createRouteLoadLatch()

	async function loadStatus(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		try {
			const response = await fetch(twoFactorApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountTwoFactorPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load two-factor status.')
			}
			enabled = payload.enabled
			status = 'ready'
			message = null
			messageTone = 'info'
			loadLatch.markLoaded(href)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load two-factor status.'
			messageTone = 'error'
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	async function postTwoFactorAction(body: Record<string, unknown>) {
		const response = await fetch(twoFactorApiPath, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			credentials: 'include',
			body: JSON.stringify(body),
		})
		if (response.status === 401) {
			window.location.assign('/login')
			return null
		}
		const payload = await readJson<{
			ok?: boolean
			enabled?: boolean
			otpUri?: string
			secret?: string
			error?: string
		}>(response)
		if (!response.ok || !payload?.ok) {
			throw new Error(payload?.error || 'Unable to update two-factor settings.')
		}
		return payload
	}

	async function handleStartSetup() {
		actionStatus = 'busy'
		message = null
		handle.update()

		try {
			const payload = await postTwoFactorAction({ intent: 'setup' })
			// A null payload means a 401 redirect is already in flight.
			if (!payload) return
			if (!payload.otpUri || !payload.secret) {
				message = 'The server returned an incomplete two-factor setup.'
				messageTone = 'error'
				return
			}
			let qrCodeDataUrl: string | null = null
			try {
				qrCodeDataUrl = await toDataURL(payload.otpUri, { width: 240 })
			} catch {
				qrCodeDataUrl = null
			}
			setup = { otpUri: payload.otpUri, secret: payload.secret, qrCodeDataUrl }
			confirmCode = ''
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to start two-factor setup.'
			messageTone = 'error'
		} finally {
			actionStatus = 'idle'
			handle.update()
		}
	}

	async function handleConfirmSetup(event: SubmitEvent) {
		event.preventDefault()
		const code = confirmCode.trim()
		if (!code) {
			message = 'Enter the code from your authenticator app.'
			messageTone = 'error'
			handle.update()
			return
		}

		actionStatus = 'busy'
		message = null
		handle.update()

		try {
			const payload = await postTwoFactorAction({ intent: 'confirm', code })
			if (!payload) return
			enabled = payload.enabled === true
			setup = null
			confirmCode = ''
			message = 'Two-factor authentication is enabled.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to confirm two-factor setup.'
			messageTone = 'error'
		} finally {
			actionStatus = 'idle'
			handle.update()
		}
	}

	async function handleCancelSetup() {
		actionStatus = 'busy'
		message = null
		handle.update()

		try {
			const payload = await postTwoFactorAction({ intent: 'cancel' })
			// A null payload means a 401 redirect is already in flight.
			if (!payload) return
			setup = null
			confirmCode = ''
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to cancel two-factor setup.'
			messageTone = 'error'
		} finally {
			actionStatus = 'idle'
			handle.update()
		}
	}

	async function handleDisable(event: SubmitEvent) {
		event.preventDefault()
		const code = disableCode.trim()
		if (!code) {
			message = 'Enter a current code to disable two-factor authentication.'
			messageTone = 'error'
			handle.update()
			return
		}

		actionStatus = 'busy'
		message = null
		handle.update()

		try {
			const payload = await postTwoFactorAction({ intent: 'disable', code })
			if (!payload) return
			enabled = payload.enabled === true
			disableCode = ''
			message = 'Two-factor authentication is disabled.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to disable two-factor authentication.'
			messageTone = 'error'
		} finally {
			actionStatus = 'idle'
			handle.update()
		}
	}

	function updateConfirmCode(event: InputEvent) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		confirmCode = event.currentTarget.value
		handle.update()
	}

	function updateDisableCode(event: InputEvent) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		disableCode = event.currentTarget.value
		handle.update()
	}

	function applyRouteLoaderData(href: string) {
		if (!isTwoFactorPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'accountTwoFactor',
			href,
		)
		if (!routeData) return false
		enabled = routeData.enabled
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
			handle.queueTask(loadStatus)
		}
		const isBusy = actionStatus === 'busy'

		return (
			<AccountManagementShell maxWidth={layoutMaxWidths.content}>
				<AccountManagementHeader
					title="Two-factor authentication"
					description="Add a one-time code from an authenticator app as a second step when signing in."
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading two-factor status…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' && enabled ? (
					<section mix={css(cardCss)}>
						<h2 mix={css(cardTitleCss)}>
							Two-factor authentication is enabled
						</h2>
						<p mix={css(descriptionCss)}>
							Signing in requires your password and a one-time code from your
							authenticator app. To disable it, confirm a current code below.
						</p>
						<form
							mix={[
								css({ display: 'grid', gap: spacing.md }),
								on('submit', handleDisable),
							]}
						>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Verification code</span>
								<input
									type="text"
									name="code"
									required
									inputMode="numeric"
									autoComplete="one-time-code"
									pattern="[0-9]{6}"
									placeholder="123456"
									value={disableCode}
									mix={[css(inputCss), on('input', updateDisableCode)]}
								/>
							</label>
							<div>
								<button
									type="submit"
									disabled={isBusy}
									mix={css(dangerButtonCss)}
								>
									{isBusy ? 'Working...' : 'Disable 2FA'}
								</button>
							</div>
						</form>
					</section>
				) : null}

				{status === 'ready' && !enabled && !setup ? (
					<section mix={css(cardCss)}>
						<h2 mix={css(cardTitleCss)}>
							Two-factor authentication is disabled
						</h2>
						<p mix={css(descriptionCss)}>
							Two-factor authentication adds an extra layer of security to your
							account. You will need to enter a code from an authenticator app
							like 1Password or Google Authenticator each time you sign in.
						</p>
						<div>
							<button
								type="button"
								disabled={isBusy}
								mix={[css(primaryButtonCss), on('click', handleStartSetup)]}
							>
								{isBusy ? 'Working...' : 'Enable 2FA'}
							</button>
						</div>
					</section>
				) : null}

				{status === 'ready' && !enabled && setup ? (
					<section mix={css(cardCss)}>
						<h2 mix={css(cardTitleCss)}>Scan this QR code</h2>
						<p mix={css(descriptionCss)}>
							Scan the QR code with your authenticator app, or enter the setup
							key manually, then confirm with a generated code. Two-factor
							authentication stays off until you confirm.
						</p>
						{setup.qrCodeDataUrl ? (
							<img
								src={setup.qrCodeDataUrl}
								alt="Two-factor authentication QR code"
								width={240}
								height={240}
								mix={css({
									borderRadius: radius.md,
									border: `1px solid ${colors.border}`,
									backgroundColor: '#fff',
								})}
							/>
						) : null}
						<p mix={css({ color: colors.textMuted, margin: 0 })}>
							Setup key:{' '}
							<code
								data-testid="totp-secret"
								mix={css({
									fontSize: typography.fontSize.sm,
									overflowWrap: 'anywhere',
								})}
							>
								{setup.secret}
							</code>
						</p>
						<form
							mix={[
								css({ display: 'grid', gap: spacing.md }),
								on('submit', handleConfirmSetup),
							]}
						>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Verification code</span>
								<input
									type="text"
									name="code"
									required
									inputMode="numeric"
									autoComplete="one-time-code"
									pattern="[0-9]{6}"
									placeholder="123456"
									value={confirmCode}
									mix={[css(inputCss), on('input', updateConfirmCode)]}
								/>
							</label>
							<div mix={css({ display: 'flex', gap: spacing.sm })}>
								<button
									type="submit"
									disabled={isBusy}
									mix={css(primaryButtonCss)}
								>
									{isBusy ? 'Working...' : 'Confirm'}
								</button>
								<button
									type="button"
									disabled={isBusy}
									mix={[
										css(secondaryButtonCss),
										on('click', handleCancelSetup),
									]}
								>
									Cancel
								</button>
							</div>
						</form>
					</section>
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
