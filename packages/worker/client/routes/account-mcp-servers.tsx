import { formatTimestamp } from '#client/format-timestamp.ts'
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
	AccountManagementLayout,
	AccountManagementList,
	AccountManagementListItemButton,
	AccountManagementMessage,
	AccountManagementShell,
	AccountManagementSidebar,
	MetadataGrid,
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
} from '#client/styles/style-primitives.ts'

type McpServerListItem = {
	id: string
	name: string
	url: string
	enabled: boolean
	state: string
	connected: boolean
	toolCount: number
	authUrl: string | null
	error: string | null
	tools: Array<string>
	createdAt: string
	updatedAt: string
}

type AccountMcpServersPayload = {
	ok: true
	email: string
	username: string
	servers: Array<McpServerListItem>
	selectedServerId?: string
}

type MessageTone = 'info' | 'error'

const accountMcpServersApiPath = '/account/mcp-servers.json'
const accountMcpServersPath = '/account/mcp-servers'

function isAccountMcpServersPath(href: string) {
	return new URL(href, 'http://localhost').pathname === accountMcpServersPath
}

export async function accountMcpServersRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(accountMcpServersApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountMcpServersPayload>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load MCP server settings.')
	}
	return { accountMcpServers: payload }
}

function stateLabel(server: Pick<McpServerListItem, 'state' | 'enabled'>) {
	if (!server.enabled) return 'Disabled'
	switch (server.state) {
		case 'ready':
			return 'Connected'
		case 'authenticating':
			return 'Authorization required'
		case 'connecting':
			return 'Connecting'
		case 'connected':
		case 'discovering':
			return 'Discovering tools'
		case 'failed':
			return 'Connection failed'
		default:
			return 'Disconnected'
	}
}

function stateColor(server: Pick<McpServerListItem, 'state' | 'enabled'>) {
	if (!server.enabled) return colors.textMuted
	switch (server.state) {
		case 'ready':
			return colors.primary
		case 'failed':
			return colors.error
		case 'authenticating':
			return colors.error
		default:
			return colors.textMuted
	}
}

function readOAuthResultFromHref(href: string): {
	message: string
	tone: MessageTone
} | null {
	const url = new URL(href, 'http://localhost')
	const auth = url.searchParams.get('auth')
	if (auth === 'success') {
		const server = url.searchParams.get('server')
		return {
			message: server
				? `Authorized MCP server "${server}".`
				: 'Authorized MCP server.',
			tone: 'info',
		}
	}
	if (auth === 'error') {
		const reason = url.searchParams.get('reason')
		return {
			message: reason
				? `MCP server authorization failed: ${reason}`
				: 'MCP server authorization failed.',
			tone: 'error',
		}
	}
	return null
}

export function AccountMcpServersRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let actionState: 'idle' | 'busy' = 'idle'
	let email = ''
	let servers: Array<McpServerListItem> = []
	let selectedId: string | null = null
	let addName = ''
	let addUrl = ''
	let message: string | null = null
	let messageTone: MessageTone = 'info'
	const loadLatch = createRouteLoadLatch()
	let deleteConfirm = false
	let oauthResultConsumed = false

	const primaryButtonCss = getPrimaryButtonCss()
	const secondaryButtonCss = getSecondaryButtonCss()
	const dangerButtonCss = getDangerButtonCss()

	function selectedServer() {
		return servers.find((server) => server.id === selectedId) ?? null
	}

	function setMessage(nextMessage: string | null, tone: MessageTone = 'info') {
		message = nextMessage
		messageTone = tone
	}

	function consumeOAuthResult() {
		if (oauthResultConsumed) return
		oauthResultConsumed = true
		const result = readOAuthResultFromHref(readCurrentRouterHref(handle))
		if (!result) return
		setMessage(result.message, result.tone)
	}

	function applyPayload(payload: AccountMcpServersPayload) {
		email = payload.email
		servers = payload.servers
		deleteConfirm = false
		if (payload.selectedServerId) {
			selectedId = payload.selectedServerId
		}
		if (selectedId && !servers.some((server) => server.id === selectedId)) {
			selectedId = null
		}
	}

	async function loadServers(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		try {
			const response = await fetch(accountMcpServersApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountMcpServersPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load MCP server settings.')
			}
			applyPayload(payload)
			status = 'ready'
			loadLatch.markLoaded(href)
			consumeOAuthResult()
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to load MCP server settings.',
				'error',
			)
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	async function postAction(input: {
		body: Record<string, unknown>
		successMessage: (payload: AccountMcpServersPayload) => string | null
		failureMessage: string
	}) {
		if (actionState !== 'idle') return
		actionState = 'busy'
		setMessage(null)
		handle.update()
		try {
			const response = await fetch(accountMcpServersApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify(input.body),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountMcpServersPayload & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || input.failureMessage)
			}
			applyPayload(payload)
			actionState = 'idle'
			setMessage(input.successMessage(payload))
			handle.update()
		} catch (error) {
			actionState = 'idle'
			setMessage(
				error instanceof Error ? error.message : input.failureMessage,
				'error',
			)
			handle.update()
		}
	}

	async function addServer(form: HTMLFormElement) {
		const formData = new FormData(form)
		addName = String(formData.get('name') ?? '').trim()
		addUrl = String(formData.get('url') ?? '').trim()
		if (!addName) {
			setMessage('Server name is required.', 'error')
			handle.update()
			return
		}
		if (!addUrl) {
			setMessage('Server URL is required.', 'error')
			handle.update()
			return
		}
		await postAction({
			body: { action: 'add', name: addName, url: addUrl },
			successMessage: (payload) => {
				addName = ''
				addUrl = ''
				const added = payload.selectedServerId
					? payload.servers.find(
							(server) => server.id === payload.selectedServerId,
						)
					: null
				if (added?.authUrl && added.state === 'authenticating') {
					return `Added MCP server "${added.name}". It requires authorization before its tools become available.`
				}
				return added
					? `Added MCP server "${added.name}" (${added.toolCount} tool${added.toolCount === 1 ? '' : 's'}).`
					: 'Added MCP server.'
			},
			failureMessage: 'Unable to add MCP server.',
		})
	}

	function selectServer(server: McpServerListItem) {
		if (actionState !== 'idle') return
		selectedId = server.id
		deleteConfirm = false
		setMessage(null)
		handle.update()
	}

	function startAddServer() {
		if (actionState !== 'idle') return
		selectedId = null
		deleteConfirm = false
		setMessage(null)
		handle.update()
	}

	function applyRouteLoaderData(href: string) {
		if (!isAccountMcpServersPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'accountMcpServers',
			href,
		)
		if (!routeData) return false
		applyPayload(routeData)
		status = 'ready'
		loadLatch.markLoaded(href)
		consumeOAuthResult()
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
			handle.queueTask(loadServers)
		}
		const isMutating = actionState !== 'idle'
		const server = selectedServer()

		return (
			<AccountManagementShell>
				<AccountManagementHeader
					title={email ? `${email} MCP servers` : 'MCP servers'}
					description="Connect remote MCP servers so their tools are available to Kody as kody.mcp capabilities. Servers that require OAuth prompt for authorization after they are added."
					actions={
						<button
							type="button"
							disabled={isMutating}
							mix={[on('click', startAddServer), css(primaryButtonCss)]}
						>
							Add server
						</button>
					}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading MCP servers...
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={
							status === 'error' || messageTone === 'error' ? 'error' : 'info'
						}
					>
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' ? (
					<AccountManagementLayout
						sidebarWidth="minmax(18rem, 24rem)"
						sidebar={
							<AccountManagementSidebar
								title="Connected servers"
								description="Tools from enabled, connected servers are callable from execute via kody.mcp['server-name'].tool_name(...)."
							>
								{servers.length === 0 ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No MCP servers yet. Add one to get started.
									</p>
								) : (
									<AccountManagementList>
										{servers.map((item) => (
											<li key={item.id}>
												<AccountManagementListItemButton
													active={selectedId === item.id}
													disabled={isMutating}
													onClick={() => selectServer(item)}
												>
													<strong>{item.name}</strong>
													<span
														mix={css({
															color: stateColor(item),
															fontSize: typography.fontSize.sm,
														})}
													>
														{stateLabel(item)}
														{item.connected
															? ` · ${item.toolCount} tool${item.toolCount === 1 ? '' : 's'}`
															: ''}
													</span>
												</AccountManagementListItemButton>
											</li>
										))}
									</AccountManagementList>
								)}
							</AccountManagementSidebar>
						}
					>
						{server ? (
							<section mix={css(cardCss)}>
								<div mix={css({ display: 'grid', gap: spacing.xs })}>
									<h2 mix={css(cardTitleCss)}>{server.name}</h2>
									<p mix={css(descriptionCss)}>
										Saved MCP server connection. Kody keeps OAuth tokens and
										connection state isolated to your account.
									</p>
								</div>

								<MetadataGrid
									items={[
										{
											label: 'Status',
											value: (
												<span mix={css({ color: stateColor(server) })}>
													{stateLabel(server)}
												</span>
											),
										},
										{
											label: 'Tools',
											value: server.connected
												? `${server.toolCount} discovered`
												: '—',
										},
										{
											label: 'Added',
											value: formatTimestamp(server.createdAt),
										},
										{
											label: 'Updated',
											value: formatTimestamp(server.updatedAt),
										},
									]}
								/>

								<div mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Server URL</span>
									<code
										mix={css({
											padding: spacing.sm,
											borderRadius: radius.md,
											border: `1px solid ${colors.border}`,
											backgroundColor: colors.background,
											color: colors.text,
											fontFamily: 'monospace',
											fontSize: typography.fontSize.sm,
											overflowWrap: 'anywhere',
										})}
									>
										{server.url}
									</code>
								</div>

								{server.error ? (
									<AccountManagementMessage tone="error">
										{server.error}
									</AccountManagementMessage>
								) : null}

								{server.authUrl && server.state === 'authenticating' ? (
									<div
										mix={css({
											display: 'grid',
											gap: spacing.sm,
											padding: spacing.md,
											borderRadius: radius.md,
											border: `1px solid ${colors.primary}`,
											backgroundColor: colors.primarySoftest,
										})}
									>
										<span mix={css({ color: colors.text })}>
											This server requires OAuth authorization before its tools
											become available.
										</span>
										<div>
											<a
												href={server.authUrl}
												mix={css({
													...primaryButtonCss,
													display: 'inline-block',
													textDecoration: 'none',
												})}
											>
												Authorize {server.name}
											</a>
										</div>
									</div>
								) : null}

								{server.connected && server.tools.length > 0 ? (
									<div mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Discovered tools</span>
										<ul
											mix={css({
												margin: 0,
												paddingLeft: spacing.lg,
												color: colors.text,
												display: 'grid',
												gap: spacing.xs,
											})}
										>
											{server.tools.map((tool) => (
												<li key={tool}>
													<code
														mix={css({
															fontFamily: 'monospace',
															fontSize: typography.fontSize.sm,
														})}
													>
														{tool}
													</code>
												</li>
											))}
										</ul>
									</div>
								) : null}

								<div
									mix={css({
										display: 'flex',
										gap: spacing.sm,
										flexWrap: 'wrap',
									})}
								>
									<button
										type="button"
										disabled={isMutating}
										mix={[
											on('click', () =>
												postAction({
													body: { action: 'reconnect', id: server.id },
													successMessage: () => 'Reconnect requested.',
													failureMessage: 'Unable to reconnect MCP server.',
												}),
											),
											css(primaryButtonCss),
										]}
									>
										Reconnect
									</button>
									<button
										type="button"
										disabled={isMutating}
										mix={[
											on('click', () =>
												postAction({
													body: { action: 'refresh', id: server.id },
													successMessage: () => 'Refreshed server tools.',
													failureMessage: 'Unable to refresh MCP server tools.',
												}),
											),
											css(secondaryButtonCss),
										]}
									>
										Refresh tools
									</button>
									<button
										type="button"
										disabled={isMutating}
										mix={[
											on('click', () =>
												postAction({
													body: {
														action: 'set-enabled',
														id: server.id,
														enabled: !server.enabled,
													},
													successMessage: () =>
														server.enabled
															? 'Disabled MCP server.'
															: 'Enabled MCP server.',
													failureMessage: 'Unable to update MCP server.',
												}),
											),
											css(secondaryButtonCss),
										]}
									>
										{server.enabled ? 'Disable' : 'Enable'}
									</button>
									<button
										type="button"
										disabled={isMutating}
										mix={[
											on('click', () => {
												if (!deleteConfirm) {
													deleteConfirm = true
													handle.update()
													return
												}
												void postAction({
													body: { action: 'delete', id: server.id },
													successMessage: () => 'Removed MCP server.',
													failureMessage: 'Unable to remove MCP server.',
												})
											}),
											css(dangerButtonCss),
										]}
									>
										{deleteConfirm ? 'Confirm remove' : 'Remove'}
									</button>
								</div>
							</section>
						) : (
							<form
								method="post"
								noValidate
								mix={[
									on('submit', (event) => {
										event.preventDefault()
										if (event.currentTarget instanceof HTMLFormElement) {
											void addServer(event.currentTarget)
										}
									}),
									css(cardCss),
								]}
							>
								<div mix={css({ display: 'grid', gap: spacing.xs })}>
									<h2 mix={css(cardTitleCss)}>Add MCP server</h2>
									<p mix={css(descriptionCss)}>
										Provide a short name and the server URL. Remote servers must
										use https; Kody connects as an MCP client and discovers the
										server&apos;s tools.
									</p>
								</div>

								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Server name</span>
									<input
										name="name"
										type="text"
										value={addName}
										placeholder="linear"
										disabled={isMutating}
										required
										mix={[
											on('input', (event) => {
												addName = event.currentTarget.value
												handle.update()
											}),
											css(inputCss),
										]}
									/>
									<span mix={css(descriptionCss)}>
										Lowercase letters, numbers, and dashes. Used as the
										kody.mcp[&quot;name&quot;] namespace.
									</span>
								</label>

								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Server URL</span>
									<input
										name="url"
										type="url"
										value={addUrl}
										placeholder="https://mcp.example.com/mcp"
										disabled={isMutating}
										required
										mix={[
											on('input', (event) => {
												addUrl = event.currentTarget.value
												handle.update()
											}),
											css(inputCss),
										]}
									/>
								</label>

								<div>
									<button
										type="submit"
										disabled={isMutating}
										mix={css(primaryButtonCss)}
									>
										{actionState === 'busy' ? 'Adding...' : 'Add server'}
									</button>
								</div>
							</form>
						)}
					</AccountManagementLayout>
				) : null}
			</AccountManagementShell>
		)
	}
}
