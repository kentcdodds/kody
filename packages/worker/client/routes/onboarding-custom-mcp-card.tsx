import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { openOnboardingMcpOAuthPopup } from '#client/mcp-oauth-popup.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { routes } from '#universal/routes.ts'
import { type OnboardingCustomMcpServer } from '#universal/onboarding-mcp-chooser.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import {
	getAuthInputCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

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

type OnboardingCustomMcpCardProps = {
	servers: Array<OnboardingCustomMcpServer>
	loggedIn: boolean
	onChanged: () => void
	onAuthStarted: () => void
}

/**
 * Step 2 "Custom" exit: add any remote MCP server with the same add/reconnect
 * API as `/account/mcp-servers/new`. Counts as a workspace connect.
 */
export function OnboardingCustomMcpCard(
	handle: Handle<OnboardingCustomMcpCardProps>,
) {
	let name = ''
	let url = ''
	let bearerToken = ''
	let showBearer = false
	let actionState: 'idle' | 'busy' = 'idle'
	let reconnectingId: string | null = null
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

	function authUrlFromPayload(
		payload: AccountMcpServersAddPayload,
		fallbackName: string,
	) {
		const selected = payload.selectedServerId
			? payload.servers?.find(
					(server) => server.id === payload.selectedServerId,
				)
			: payload.servers?.find((server) => server.name === fallbackName)
		return selected?.authUrl ?? null
	}

	async function addServer() {
		if (actionState !== 'idle') return
		if (!handle.props.loggedIn) {
			requireLogin()
			return
		}
		const trimmedName = name.trim()
		const trimmedUrl = url.trim()
		if (!trimmedName || !trimmedUrl) {
			error = 'Name and URL are required.'
			handle.update()
			return
		}
		actionState = 'busy'
		error = null
		handle.update()
		try {
			const token = bearerToken.trim()
			const payload = await postMcpServerAction({
				action: 'add',
				name: trimmedName,
				url: trimmedUrl,
				...(token ? { bearerToken: token } : {}),
			})
			if (!payload) return
			const authUrl = authUrlFromPayload(payload, trimmedName)
			if (authUrl) openAuthUrl(authUrl)
			name = ''
			url = ''
			bearerToken = ''
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

	async function reconnect(server: OnboardingCustomMcpServer) {
		if (reconnectingId != null) return
		if (!handle.props.loggedIn) {
			requireLogin()
			return
		}
		if (server.connected) return
		if (server.authUrl) {
			openAuthUrl(server.authUrl)
			return
		}
		reconnectingId = server.id
		error = null
		handle.update()
		try {
			const payload = await postMcpServerAction({
				action: 'reconnect',
				id: server.id,
			})
			if (!payload) return
			const authUrl = authUrlFromPayload(payload, server.name)
			if (authUrl) openAuthUrl(authUrl)
			handle.props.onChanged()
		} catch (caught) {
			error =
				caught instanceof Error
					? caught.message
					: 'Unable to reconnect MCP server.'
		} finally {
			reconnectingId = null
			handle.update()
		}
	}

	return () => {
		const busy = actionState === 'busy'
		return (
			<div mix={css(cardCss)} data-testid="onboarding-custom-mcp">
				<em mix={css(eyebrowCss)}>Custom</em>
				<strong mix={css(titleCss)}>Add any remote MCP server</strong>
				<p mix={css(copyCss)}>
					Same easy login path — name plus URL. If the server returns an
					authorize link, we open it. Used as{' '}
					<code mix={css(codeCss)}>kody.mcp[&quot;name&quot;]</code>.
				</p>
				{handle.props.servers.length > 0 ? (
					<ul mix={css(serverListCss)}>
						{handle.props.servers.map((server) => (
							<li
								key={server.id}
								mix={css(serverRowCss)}
								data-connected={server.connected ? 'true' : undefined}
								data-testid={`onboarding-custom-mcp-${server.id}`}
							>
								<span mix={css(serverMetaCss)}>
									<strong mix={css(serverNameCss)}>{server.name}</strong>
									<span mix={css(serverUrlCss)}>{server.url}</span>
								</span>
								<button
									type="button"
									disabled={server.connected || reconnectingId === server.id}
									mix={[
										css(
											server.connected
												? connectedButtonCss
												: reconnectButtonCss,
										),
										on('click', () => void reconnect(server)),
									]}
									data-testid={`onboarding-custom-mcp-${server.id}-connect`}
								>
									{server.connected
										? 'Connected'
										: reconnectingId === server.id
											? 'Connecting…'
											: server.authUrl
												? 'Authorize'
												: 'Reconnect'}
								</button>
								{server.error && !server.connected ? (
									<p mix={css(errorCss)} role="alert">
										{server.error}
									</p>
								) : null}
							</li>
						))}
					</ul>
				) : null}
				<form
					mix={[
						css(formCss),
						on('submit', (event) => {
							event.preventDefault()
							void addServer()
						}),
					]}
				>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Server name</span>
						<input
							data-field-ring
							name="name"
							type="text"
							value={name}
							placeholder="acme"
							disabled={busy}
							required
							autocomplete="off"
							mix={[
								on('input', (event) => {
									name = event.currentTarget.value
									handle.update()
								}),
								css(inputCss),
							]}
						/>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Server URL</span>
						<input
							data-field-ring
							name="url"
							type="url"
							value={url}
							placeholder="https://mcp.example.com/mcp"
							disabled={busy}
							required
							autocomplete="off"
							mix={[
								on('input', (event) => {
									url = event.currentTarget.value
									handle.update()
								}),
								css(inputCss),
							]}
						/>
					</label>
					{showBearer ? (
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Bearer token (optional)</span>
							<input
								data-field-ring
								name="bearerToken"
								type="password"
								value={bearerToken}
								placeholder="Only if the server uses a static token"
								disabled={busy}
								autocomplete="off"
								mix={[
									on('input', (event) => {
										bearerToken = event.currentTarget.value
										handle.update()
									}),
									css(inputCss),
								]}
							/>
						</label>
					) : (
						<button
							type="button"
							mix={[
								css(tokenToggleCss),
								on('click', () => {
									showBearer = true
									handle.update()
								}),
							]}
						>
							Uses a static bearer token?
						</button>
					)}
					<button
						type="submit"
						disabled={busy}
						mix={css(submitCss)}
						data-testid="onboarding-custom-mcp-add"
					>
						{busy ? 'Connecting…' : 'Add custom MCP'}
					</button>
				</form>
				{error ? (
					<p mix={css(errorCss)} role="alert">
						{error}
					</p>
				) : null}
			</div>
		)
	}
}

const cardCss = {
	display: 'grid',
	gap: '0.7rem',
	padding: '1.15rem 1.25rem',
	border: `1.5px dashed ${colors.border}`,
	borderRadius: '16px',
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.04)`,
}

const eyebrowCss = {
	margin: 0,
	font: `700 0.75rem/1 ${typography.fontFamilyDisplay}`,
	letterSpacing: '0.08em',
	textTransform: 'uppercase' as const,
	color: colors.primaryText,
}

const titleCss = {
	margin: 0,
	font: `720 1.1rem/1.25 ${typography.fontFamilyDisplay}`,
	color: colors.text,
}

const copyCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.92rem',
	lineHeight: 1.5,
	maxWidth: '68ch',
}

const codeCss = {
	fontSize: '0.85em',
}

const serverListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: '0.55rem',
}

const serverRowCss = {
	display: 'grid',
	gap: '0.4rem',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	alignItems: 'center',
	padding: '0.65rem 0.75rem',
	border: `1px solid ${colors.border}`,
	borderRadius: '12px',
	backgroundColor: colors.surface,
}

const serverMetaCss = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
}

const serverNameCss = {
	fontWeight: 650,
	color: colors.text,
}

const serverUrlCss = {
	color: colors.textMuted,
	fontSize: '0.82rem',
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const formCss = {
	display: 'grid',
	gap: '0.7rem',
}

const fieldCss = {
	display: 'grid',
	gap: '0.3rem',
}

const fieldLabelCss = {
	font: `650 0.82rem/1.3 ${typography.fontFamilyBody}`,
	color: colors.text,
}

const inputCss = {
	...getAuthInputCss(),
}

const tokenToggleCss = {
	...getGhostButtonCss(),
	width: 'fit-content',
	fontSize: '0.85rem',
	justifySelf: 'start',
}

const submitCss = {
	...getPillButtonCss(),
	width: 'fit-content',
}

const reconnectButtonCss = {
	...getGhostButtonCss(),
	fontSize: '0.85rem',
}

const connectedButtonCss = {
	...getGhostButtonCss(),
	fontSize: '0.85rem',
	color: colors.primaryText,
	borderColor: `oklch(from ${colors.primary} l c h / 0.45)`,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.08)`,
	cursor: 'default',
}

const errorCss = {
	margin: 0,
	gridColumn: '1 / -1',
	color: colors.error,
	font: `550 0.82rem/1.4 ${typography.fontFamilyBody}`,
}
