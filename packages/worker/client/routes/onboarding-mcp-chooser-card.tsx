import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { writeClipboardText } from '#client/clipboard.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { ProviderIcon } from '#client/provider-icons.tsx'
import { getCommunityListingHref } from '#universal/community-links.ts'
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
}

type InstallApiPayload = {
	ok: boolean
	status?: 'installed' | 'adaptation_required'
	targetName?: string
	agentPrompt?: string
	error?: string
}

/**
 * Step 2 chooser card: add an official workspace MCP server, open the
 * provider authorization URL when the hub returns one, and install the
 * matching official `@kody/<id>-mcp` helper when that listing is available.
 */
export function OnboardingMcpChooserCard(
	handle: Handle<OnboardingMcpChooserCardProps>,
) {
	let actionState: 'idle' | 'busy' = 'idle'
	let installState: 'idle' | 'busy' | 'ready' = 'idle'
	let installedAgentPrompt: string | null = null
	let error: string | null = null
	let installError: string | null = null
	let copiedPrompt = false
	let copyResetTimerId: ReturnType<typeof setTimeout> | null = null

	function requireLogin() {
		window.location.assign(
			`/login?redirectTo=${encodeURIComponent(`${routes.onboarding.href()}#connect-mcp`)}`,
		)
	}

	function openAuthUrl(authUrl: string) {
		window.open(authUrl, '_blank', 'noopener,noreferrer')
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

	async function connect() {
		if (actionState !== 'idle') return
		if (!handle.props.loggedIn) {
			requireLogin()
			return
		}
		const { server } = handle.props
		if (server.connected) return
		if (server.authUrl) {
			openAuthUrl(server.authUrl)
			return
		}

		actionState = 'busy'
		error = null
		handle.update()
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
			actionState = 'idle'
			handle.update()
		}
	}

	async function installPackage() {
		const listing = handle.props.server.packageListing
		if (!listing || installState === 'busy') return
		if (!handle.props.loggedIn) {
			requireLogin()
			return
		}
		const existingPrompt =
			listing.viewerInstall?.agentPrompt ?? installedAgentPrompt
		if (listing.viewerInstall || installState === 'ready') {
			if (existingPrompt) await copyPrompt(existingPrompt)
			return
		}

		installState = 'busy'
		installError = null
		handle.update()
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
					payload?.error ?? 'Unable to install this community package.',
				)
			}
			if (payload.agentPrompt) {
				installedAgentPrompt = payload.agentPrompt
				await copyPrompt(payload.agentPrompt)
			}
			installState = 'ready'
			handle.props.onChanged()
		} catch (caught) {
			installState = 'idle'
			installError =
				caught instanceof Error
					? caught.message
					: 'Unable to install this community package.'
		} finally {
			handle.update()
		}
	}

	async function copyPrompt(prompt: string) {
		try {
			await writeClipboardText(prompt)
			copiedPrompt = true
		} catch {
			copiedPrompt = false
		}
		handle.update()
		if (copyResetTimerId != null) clearTimeout(copyResetTimerId)
		copyResetTimerId = setTimeout(() => {
			copyResetTimerId = null
			if (handle.signal.aborted) return
			copiedPrompt = false
			handle.update()
		}, 2000)
	}

	return () => {
		const { server } = handle.props
		const busy = actionState === 'busy'
		const listing = server.packageListing
		const existingInstall = listing?.viewerInstall ?? null
		const label = server.connected
			? 'Connected'
			: server.authUrl
				? `Authorize ${server.label}`
				: server.serverId
					? `Reconnect ${server.label}`
					: `Connect ${server.label}`
		const locallyInstalled = installState === 'ready'
		const packageLabel = existingInstall
			? copiedPrompt
				? 'Copied prompt'
				: 'Copy package prompt'
			: installState === 'busy'
				? 'Installing…'
				: locallyInstalled
					? copiedPrompt
						? 'Installed — prompt copied'
						: 'Installed'
					: `Install @kody/${server.packageKodyId}`

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
				{listing ? (
					<div mix={css(packageRowCss)}>
						<a
							href={getCommunityListingHref({
								listingId: listing.id,
								listingName: listing.name,
								kodyId: listing.kodyId,
							})}
							target="_blank"
							rel="noreferrer noopener"
							mix={css(packageLinkCss)}
						>
							{listing.name}
						</a>
						<button
							type="button"
							disabled={
								installState === 'busy' ||
								(installState === 'ready' && !existingInstall)
							}
							mix={[
								css(packageButtonCss),
								on('click', () => void installPackage()),
							]}
							data-testid={`onboarding-mcp-${server.id}-install`}
						>
							{packageLabel}
						</button>
					</div>
				) : null}
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
				{installError ? (
					<p mix={css(errorCss)} role="alert">
						{installError}
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

const packageRowCss = {
	display: 'grid',
	gap: '0.35rem',
	width: '100%',
	marginTop: '0.15rem',
}

const packageLinkCss = {
	color: colors.textMuted,
	font: `550 0.82rem/1.35 ${typography.fontFamilyBody}`,
	textAlign: 'center' as const,
	textDecoration: 'none',
	'&:hover': {
		color: colors.primaryText,
		textDecoration: 'underline',
	},
}

const packageButtonCss = {
	...getGhostButtonCss(),
	width: '100%',
	fontSize: '0.85rem',
}
