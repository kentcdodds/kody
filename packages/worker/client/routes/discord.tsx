import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { ProviderIcon } from '#client/provider-icons.tsx'
import { startSocialSignIn } from '#client/social-sign-in.ts'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	honeypotFieldName,
	readPublicFormProtection,
	renderTurnstileWidgets,
	resetTurnstileWidgets,
	turnstileWidgetClassName,
} from '#client/public-form-protection.ts'
import { kodyDiscordInviteUrl } from '#universal/community-links.ts'
import { getOauthLoginErrorMessage } from '#universal/oauth-login-errors.ts'
import {
	type AccountConnectionsLoaderData,
	type DiscordPageLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	getGhostButtonCss,
	getPillButtonCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { buildAuthLink } from '#client/auth-links.ts'

const discordApiPath = routes.discordApi.href()
const discordPath = routes.discord.href()

function isDiscordPagePath(href: string) {
	return new URL(href, 'http://localhost').pathname === discordPath
}

function readCallbackMessage(href: string) {
	const searchParams = new URL(href, 'http://localhost').searchParams
	const linkedProvider = searchParams.get('oauthLinked')
	if (linkedProvider === 'discord') {
		return {
			text: 'Discord connected to your Kody account.',
			tone: 'info' as const,
		}
	}
	const error = getOauthLoginErrorMessage(searchParams.get('oauthError'))
	if (error) {
		return { text: error, tone: 'error' as const }
	}
	return null
}

function discordMemberRoleMessage(status: string) {
	switch (status) {
		case 'assigned':
			return 'Kody Discord roles updated.'
		case 'not-in-guild':
			return 'Join the Kody Discord first, then sync your roles.'
		case 'not-configured':
		case 'skipped':
			return 'Discord role sync is not configured.'
		case 'forbidden':
			return 'Kody could not update your Discord roles. Please try again later.'
		default:
			return 'Unable to sync Discord roles.'
	}
}

export async function discordRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(discordApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	const payload = await readJson<DiscordPageLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load Discord connection status.')
	}
	return { discord: payload }
}

export function DiscordRoute(handle: Handle) {
	let status: 'loading' | 'ready' | 'error' = 'loading'
	let page: DiscordPageLoaderData | null = null
	let busy = false
	let actionMessage: { text: string; tone: 'error' | 'info' } | null = null
	const loadLatch = createRouteLoadLatch()

	async function loadPage(signal: AbortSignal) {
		try {
			const response = await fetch(discordApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			const payload = await readJson<DiscordPageLoaderData>(response)
			if (signal.aborted) return
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load Discord connection status.')
			}
			page = payload
			status = 'ready'
			handle.update()
		} catch {
			if (signal.aborted) return
			status = 'error'
			handle.update()
		}
	}

	async function handleConnectDiscord() {
		busy = true
		actionMessage = null
		handle.update()
		try {
			const connectForm = document.querySelector<HTMLFormElement>(
				'form[data-discord-connect-form]',
			)
			const protection =
				page?.signedIn || !connectForm
					? { website: '', turnstileToken: '' }
					: readPublicFormProtection(new FormData(connectForm))
			const errorMessage = await startSocialSignIn(
				'discord',
				discordPath,
				null,
				protection,
			)
			if (errorMessage) {
				actionMessage = { text: errorMessage, tone: 'error' }
				busy = false
				resetTurnstileWidgets()
			}
		} catch {
			actionMessage = {
				text: 'Network error. Please try again.',
				tone: 'error',
			}
			busy = false
			resetTurnstileWidgets()
		}
		handle.update()
	}

	async function handleSyncRoles() {
		busy = true
		actionMessage = null
		handle.update()
		try {
			const response = await fetch(routes.accountConnectionsApi.href(), {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ intent: 'sync-discord-role' }),
			})
			if (response.status === 401) {
				window.location.assign(buildAuthLink(routes.login.href(), discordPath))
				return
			}
			const payload = await readJson<
				AccountConnectionsLoaderData & {
					error?: string
					discordMemberRole?: { status: string }
				}
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to sync Discord roles.')
			}
			const syncStatus = payload?.discordMemberRole?.status ?? 'error'
			actionMessage = {
				text: discordMemberRoleMessage(syncStatus),
				tone:
					syncStatus === 'assigned' || syncStatus === 'not-in-guild'
						? 'info'
						: 'error',
			}
		} catch (error) {
			actionMessage = {
				text:
					error instanceof Error
						? error.message
						: 'Unable to sync Discord roles.',
				tone: 'error',
			}
		} finally {
			busy = false
			handle.update()
		}
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		if (!isDiscordPagePath(currentHref)) {
			return <section mix={css(stackedPageCss)} />
		}

		const routeData = tryConsumeRouteLoaderData(handle, 'discord', currentHref)
		const appliedRouteData = Boolean(routeData?.ok)
		if (routeData?.ok) {
			page = routeData
			status = 'ready'
			loadLatch.markLoaded(currentHref)
		}

		const needsStaleRefresh = consumeStaleNavigationData(currentHref)
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			const loadAttempt = loadLatch.getPendingAttempt()
			handle.queueTask(async (signal) => {
				try {
					await loadPage(signal)
					if (signal.aborted) {
						loadLatch.clearPending(currentHref, loadAttempt)
						return
					}
					if (status === 'ready') loadLatch.markLoaded(currentHref)
					else loadLatch.markFailed(currentHref)
				} catch {
					if (signal.aborted) {
						loadLatch.clearPending(currentHref, loadAttempt)
						return
					}
					loadLatch.markFailed(currentHref)
				}
			})
		}

		const callbackMessage = readCallbackMessage(currentHref)
		const message = actionMessage ?? callbackMessage
		const inviteUrl = page?.inviteUrl ?? kodyDiscordInviteUrl
		const turnstileSiteKey = page?.turnstileSiteKey ?? null
		if (
			typeof document !== 'undefined' &&
			page &&
			!page.signedIn &&
			turnstileSiteKey
		) {
			handle.queueTask(() => renderTurnstileWidgets(turnstileSiteKey))
		}

		return (
			<section mix={css(stackedPageCss)}>
				<header mix={css(pageHeaderCss)}>
					<h1 mix={css(pageTitleCss)}>Discord</h1>
					<p mix={css(pageDescriptionCss)}>
						The official Kody Discord is where people get help, share what they
						are building, and hear about new capabilities. Connecting your Kody
						account lets us assign the member role — and Standard or Pro if you
						subscribe.
					</p>
				</header>

				{message ? (
					<p
						role={message.tone === 'error' ? 'alert' : 'status'}
						mix={css({
							...descriptionCss,
							color:
								message.tone === 'error' ? colors.danger : colors.textMuted,
						})}
					>
						{message.text}
					</p>
				) : null}

				{status === 'error' ? (
					<p mix={css(descriptionCss)} role="alert">
						Unable to load Discord connection status.
					</p>
				) : null}

				<section mix={css(cardCss)}>
					<h2 mix={css(cardTitleCss)}>Join the server</h2>
					<p mix={css(descriptionCss)}>
						Anyone can join with the invite. Connecting your account afterward
						is what unlocks the Kody member and plan roles.
					</p>
					<a
						href={inviteUrl}
						target="_blank"
						rel="noreferrer"
						mix={css(getGhostButtonCss())}
					>
						<ProviderIcon providerId="discord" size="1.1em" />
						Join the Kody Discord
					</a>
				</section>

				<section mix={css(cardCss)}>
					<h2 mix={css(cardTitleCss)}>Connect your Kody account</h2>
					{status === 'loading' && !page ? (
						<p mix={css(descriptionCss)}>Checking your connection…</p>
					) : null}
					{page?.signedIn && page.discordConnected ? (
						<>
							<p mix={css(descriptionCss)}>
								Your Kody account is already connected
								{page.discordDisplayName
									? ` as ${page.discordDisplayName}`
									: ''}
								. You can manage connections from{' '}
								<a href={routes.account.href()} mix={css(mutedLinkCss)}>
									your account
								</a>
								.
							</p>
							{page.canSyncDiscordRoles ? (
								<button
									type="button"
									disabled={busy}
									mix={[css(getGhostButtonCss()), on('click', handleSyncRoles)]}
								>
									Sync Discord roles
								</button>
							) : null}
						</>
					) : null}
					{page?.signedIn && !page.discordConnected ? (
						<>
							<p mix={css(descriptionCss)}>
								Your Kody account is not connected to Discord yet. Connect it so
								we can match this Discord user to your assistant.
							</p>
							{page.discordProviderAvailable ? (
								<button
									type="button"
									disabled={busy}
									mix={[
										css(getPillButtonCss()),
										on('click', handleConnectDiscord),
									]}
								>
									<ProviderIcon providerId="discord" size="1.1em" />
									Connect to Discord
								</button>
							) : (
								<p mix={css(descriptionCss)}>
									Discord login is not configured on this deployment yet.
								</p>
							)}
						</>
					) : null}
					{page && !page.signedIn ? (
						<>
							<p mix={css(descriptionCss)}>
								Sign in with Discord to create or match your Kody account, or
								log in another way and then connect Discord from here.
							</p>
							<form
								data-discord-connect-form
								mix={[
									css({
										display: 'flex',
										flexWrap: 'wrap',
										gap: spacing.sm,
										alignItems: 'center',
									}),
									on('submit', (event) => {
										event.preventDefault()
									}),
								]}
							>
								<input
									type="text"
									name={honeypotFieldName}
									tabIndex={-1}
									autoComplete="off"
									aria-hidden="true"
									mix={css(visuallyHiddenCss)}
								/>
								{turnstileSiteKey ? (
									<div class={turnstileWidgetClassName}></div>
								) : null}
								{page.discordProviderAvailable ? (
									<button
										type="button"
										disabled={busy}
										mix={[
											css(getPillButtonCss()),
											on('click', handleConnectDiscord),
										]}
									>
										<ProviderIcon providerId="discord" size="1.1em" />
										Connect to Discord
									</button>
								) : null}
								<a
									href={buildAuthLink(routes.login.href(), discordPath)}
									mix={css(
										page.discordProviderAvailable
											? getGhostButtonCss()
											: getPillButtonCss(),
									)}
								>
									Sign in
								</a>
							</form>
						</>
					) : null}
				</section>
			</section>
		)
	}
}
