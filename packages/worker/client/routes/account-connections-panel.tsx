import { type Handle, css } from 'remix/ui'
import { getOauthLoginErrorMessage } from '#universal/oauth-login-errors.ts'
import { on } from '#client/event-mixin.ts'
import { ProviderIcon } from '#client/provider-icons.tsx'
import { startSocialSignIn } from '#client/social-sign-in.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	type AccountConnectionListItem,
	type AccountConnectionsLoaderData,
} from '#universal/loader-data.ts'
import { kodyDiscordInviteUrl } from '#universal/community-links.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	mutedLinkCss,
} from '#universal/styles/style-primitives.ts'
import { AccountManagementPanel } from '#client/routes/account-management-components.tsx'

const connectionsApiPath = '/account/connections.json'

const providerLabels: Record<string, string> = {
	github: 'GitHub',
	google: 'Google',
	x: 'X',
	discord: 'Discord',
}

/** One-shot message from the OAuth callback redirect query params. */
export function readConnectionCallbackMessage(href: string) {
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

export function createAccountConnections(handle: Handle) {
	let connectionsBusy = false
	let connections: Array<AccountConnectionListItem> = []
	let canDisconnect = true
	let hasUsablePassword = false
	let availableProviders: Array<{ id: string; label: string }> = []
	let canSyncDiscordRoles = false
	let connectionsMessage: { text: string; tone: 'error' | 'info' } | null = null

	function applyPayload(payload: AccountConnectionsLoaderData) {
		connections = payload.connections
		canDisconnect = payload.canDisconnect
		hasUsablePassword = payload.hasUsablePassword
		availableProviders = payload.availableProviders
		canSyncDiscordRoles = payload.canSyncDiscordRoles
	}

	async function connectProvider(providerId: string) {
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

	async function syncDiscordMemberRole() {
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
				body: JSON.stringify({ intent: 'sync-discord-role' }),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountConnectionsLoaderData & {
					error?: string
					discordMemberRole?: { status: string }
				}
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to sync the Discord role.')
			}
			applyPayload(payload)
			const status = payload.discordMemberRole?.status ?? 'error'
			connectionsMessage = {
				text: discordMemberRoleMessage(status),
				tone:
					status === 'assigned' || status === 'not-in-guild' ? 'info' : 'error',
			}
		} catch (error) {
			connectionsMessage = {
				text:
					error instanceof Error
						? error.message
						: 'Unable to sync the Discord role.',
				tone: 'error',
			}
		} finally {
			connectionsBusy = false
			handle.update()
		}
	}

	async function disconnectProvider(providerId: string) {
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
			applyPayload(payload)
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

	return {
		applyPayload,
		get hasUsablePassword() {
			return hasUsablePassword
		},
		setMessage(next: { text: string; tone: 'error' | 'info' } | null) {
			connectionsMessage = next ?? connectionsMessage
		},
		render() {
			return renderPanel()
		},
	}

	function renderPanel() {
		const onConnectProvider = (providerId: string) =>
			void connectProvider(providerId)
		const onDisconnectProvider = (providerId: string) =>
			void disconnectProvider(providerId)
		const onSyncDiscordMemberRole = () => void syncDiscordMemberRole()
		return (
			<AccountManagementPanel
				title="Connected accounts"
				description="Sign in with GitHub, Google, X, or Discord by connecting them to this account. Connections with the same verified email also link automatically at sign-in."
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
										{connection.provider === 'discord' ? (
											<a
												href={kodyDiscordInviteUrl}
												target="_blank"
												rel="noreferrer"
												mix={css(mutedLinkCss)}
											>
												Join the Kody Discord
											</a>
										) : null}
									</span>
									<span
										mix={css({
											display: 'flex',
											gap: spacing.sm,
											flexWrap: 'wrap',
										})}
									>
										{connection.provider === 'discord' &&
										canSyncDiscordRoles ? (
											<button
												type="button"
												disabled={connectionsBusy}
												mix={[
													css(compactGhostButtonCss),
													on('click', onSyncDiscordMemberRole),
												]}
											>
												Sync Discord roles
											</button>
										) : null}
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
													onDisconnectProvider(connection.provider),
												),
											]}
										>
											Disconnect
										</button>
									</span>
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
										css(compactGhostButtonCss),
										on('click', () => onConnectProvider(provider.id)),
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
		)
	}
}

const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })

const dangerButtonCss = getDangerPillCss({ size: 'sm' })
