import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { openOnboardingMcpOAuthPopup } from '#client/mcp-oauth-popup.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { ProviderIcon } from '#client/provider-icons.tsx'
import { routes } from '#universal/routes.ts'
import { type OnboardingFeaturedMcpServer } from '#universal/onboarding-mcp-chooser.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getLogoWellCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { starterCardCss } from '#client/routes/onboarding-starter-card.tsx'

type AccountMcpServersAddPayload = {
	ok?: boolean
	error?: string
	selectedServerId?: string
	servers?: Array<{
		id: string
		name: string
		state: string
		authUrl: string | null
	}>
}

type OnboardingMcpChooserCardProps = {
	server: OnboardingFeaturedMcpServer
	loggedIn: boolean
	onChanged: () => void
	onAuthStarted: () => void
}

type InstallApiPayload = {
	ok: boolean
	status?: 'installed' | 'adaptation_required'
	targetName?: string
	agentPrompt?: string
	error?: string
}

/**
 * Step 2 chooser card: add an official workspace MCP server, fork the
 * matching `@kody/<id>-mcp` listing in the same click, and open the
 * provider authorization URL in a popup that returns to the wizard.
 */
export function OnboardingMcpChooserCard(
	handle: Handle<OnboardingMcpChooserCardProps>,
) {
	let actionState: 'idle' | 'busy' = 'idle'
	let error: string | null = null

	function requireLogin() {
		window.location.assign(
			`/login?redirectTo=${encodeURIComponent(`${routes.onboarding.href()}#connect-mcp`)}`,
		)
	}

	function openAuthUrl(authUrl: string) {
		handle.props.onAuthStarted()
		openOnboardingMcpOAuthPopup(authUrl)
	}

	async function postMcpServerAction(body: Record<string, unknown>) {
		const response = await fetch(routes.accountMcpServersApi.href(), {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			credentials: 'include',
			body: JSON.stringify(body),
		})
		if (response.status === 401) {
			requireLogin()
			return null
		}
		const payload = await readJson<AccountMcpServersAddPayload>(response)
		if (!response.ok || !payload?.ok) {
			throw new Error(payload?.error || 'Unable to connect MCP server.')
		}
		return payload
	}

	function authUrlFromPayload(payload: AccountMcpServersAddPayload) {
		const selected = payload.selectedServerId
			? payload.servers?.find(
					(server) => server.id === payload.selectedServerId,
				)
			: payload.servers?.find(
					(server) => server.name === handle.props.server.name,
				)
		return selected?.authUrl ?? null
	}

	async function forkMatchingPackage() {
		const listing = handle.props.server.packageListing
		if (!listing || listing.viewerInstall) return
		try {
			const response = await fetch(
				routes.communityInstallApiPost.href({ listingId: listing.id }),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({}),
				},
			)
			if (response.status === 401) {
				requireLogin()
				return
			}
			const payload = await readJson<InstallApiPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(
					payload?.error ?? 'Unable to fork the matching community package.',
				)
			}
		} catch (caught) {
			error =
				caught instanceof Error
					? caught.message
					: 'Unable to fork the matching community package.'
			handle.update()
		}
	}

	async function connect() {
		if (actionState !== 'idle') return
		if (!handle.props.loggedIn) {
			requireLogin()
			return
		}
		const { server } = handle.props
		if (server.connected) return
		if (server.authUrl) {
			void forkMatchingPackage()
			openAuthUrl(server.authUrl)
			return
		}

		actionState = 'busy'
		error = null
		handle.update()
		const fork = forkMatchingPackage()
		try {
			const payload = server.serverId
				? await postMcpServerAction({
						action: 'reconnect',
						id: server.serverId,
					})
				: await postMcpServerAction({
						action: 'add',
						name: server.name,
						url: server.url,
					})
			if (!payload) return
			const authUrl = authUrlFromPayload(payload)
			if (authUrl) openAuthUrl(authUrl)
			handle.props.onChanged()
		} catch (caught) {
			error =
				caught instanceof Error
					? caught.message
					: 'Unable to connect MCP server.'
		} finally {
			await fork
			actionState = 'idle'
			handle.update()
		}
	}

	return () => {
		const { server } = handle.props
		const busy = actionState === 'busy'
		const label = server.connected
			? 'Connected'
			: server.authUrl
				? `Authorize ${server.label}`
				: server.serverId
					? `Reconnect ${server.label}`
					: `Connect ${server.label}`

		return (
			<li
				mix={css(cardCss)}
				data-connected={server.connected ? 'true' : undefined}
				data-testid={`onboarding-mcp-${server.id}`}
			>
				<span mix={css(iconWellCss)}>
					<ProviderIcon providerId={server.id} size="30" />
				</span>
				<strong mix={css(nameCss)}>{server.label}</strong>
				<span mix={css(descriptionCss)}>{server.description}</span>
				<button
					type="button"
					disabled={busy || server.connected}
					mix={[
						css(server.connected ? connectedButtonCss : connectButtonCss),
						on('click', () => void connect()),
					]}
					data-testid={`onboarding-mcp-${server.id}-connect`}
				>
					{busy ? 'Connecting…' : label}
				</button>
				{server.error && !server.connected ? (
					<p mix={css(errorCss)} role="alert">
						{server.error}
					</p>
				) : null}
				{error ? (
					<p mix={css(errorCss)} role="alert">
						{error}
					</p>
				) : null}
			</li>
		)
	}
}

const cardCss = {
	...starterCardCss,
}

const iconWellCss = {
	...getLogoWellCss({ size: '3.2rem', radius: '12px' }),
	marginBottom: '0.2rem',
}

const nameCss = {
	color: colors.text,
	fontWeight: 650,
	fontSize: '0.98rem',
}

const descriptionCss = {
	color: colors.textMuted,
	fontSize: '0.88rem',
	lineHeight: 1.45,
	textAlign: 'center' as const,
}

const connectButtonCss = {
	...getPillButtonCss(),
	marginTop: 'auto',
	width: '100%',
	fontSize: '0.95rem',
}

const connectedButtonCss = {
	...getGhostButtonCss(),
	marginTop: 'auto',
	width: '100%',
	fontSize: '0.95rem',
	color: colors.primaryText,
	borderColor: `oklch(from ${colors.primary} l c h / 0.45)`,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.08)`,
	cursor: 'default',
}

const errorCss = {
	margin: 0,
	color: colors.error,
	font: `550 0.82rem/1.4 ${typography.fontFamilyBody}`,
	textAlign: 'center' as const,
}
