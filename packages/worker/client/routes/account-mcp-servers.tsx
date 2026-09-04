import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { createDoubleCheck } from '#client/double-check.ts'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { replaceLocation } from '#client/replace-location.ts'
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
import {
	RecordDot,
	RecordTable,
	RecordTableSearch,
	recordBodyCss,
	recordCellClamp,
} from '#client/routes/record-table.tsx'
import {
	type AccountMcpServersPayload,
	type McpServerListItem,
	type McpServerUsageDraft,
	type MessageTone,
	filterServers,
	readOAuthResultFromHref,
	readSearchFilter,
	renderNamedServer,
	stateColor,
	stateLabel,
} from '#client/routes/account-mcp-servers-shared.tsx'
import { renderMcpServerDetail } from '#client/routes/account-mcp-servers-detail.tsx'
import {
	renderAddMcpServerForm,
	renderOauthCallbackSection,
} from '#client/routes/account-mcp-servers-forms.tsx'
import {
	clearOnboardingMcpOAuthReturnCookie,
	closeOnboardingMcpOAuthPopupIfOpened,
} from '#client/mcp-oauth-popup.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

const clampedCellCss = css(recordCellClamp(26))

const accountMcpServersApiPath = '/account/mcp-servers.json'
const mcpServersRoute = createListDetailRoute('/account/mcp-servers')

/**
 * Latch key for the list payload. Selection segments and the client-side `q`
 * filter do not change the GET response, so keying the latch on the base path
 * avoids spurious refetches when only those URL parts change.
 */
function getDataLatchKey(_href: string) {
	return '/account/mcp-servers'
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

export function AccountMcpServersRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let actionState: 'idle' | 'busy' = 'idle'
	let servers: Array<McpServerListItem> = []
	let savedPackages: Array<{ id: string; kodyId: string }> = []
	let usageDrafts = new Map<string, McpServerUsageDraft>()
	let usageSavingId: string | null = null
	let oauthClientOrigin = ''
	let oauthCallbackUrl = ''
	let oauthClientMetadataUrl: string | null = null
	let addName = ''
	let addUrl = ''
	let addBearerToken = ''
	let message: string | null = null
	let messageTone: MessageTone = 'info'
	const loadLatch = createRouteLoadLatch()
	const deleteServerCheck = createDoubleCheck(handle)
	let oauthResultConsumed = false
	if (typeof document !== 'undefined') {
		if (!closeOnboardingMcpOAuthPopupIfOpened()) {
			clearOnboardingMcpOAuthReturnCookie()
		}
	}

	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

	function getCurrentHref() {
		return readCurrentRouterHref(handle)
	}

	function getCurrentSearch() {
		return new URL(getCurrentHref(), 'http://localhost').search
	}

	function buildHrefWithUpdatedSearch(search: string) {
		const nextUrl = new URL(getCurrentHref(), 'http://localhost')
		if (search) nextUrl.searchParams.set('q', search)
		else nextUrl.searchParams.delete('q')
		return `${nextUrl.pathname}${nextUrl.search}`
	}

	function setMessage(nextMessage: string | null, tone: MessageTone = 'info') {
		message = nextMessage
		messageTone = tone
	}

	function consumeOAuthResult() {
		if (oauthResultConsumed) return
		oauthResultConsumed = true
		const result = readOAuthResultFromHref(getCurrentHref())
		if (!result) return
		setMessage(result.message, result.tone)
	}

	function applyPayload(payload: AccountMcpServersPayload) {
		servers = payload.servers
		savedPackages = payload.savedPackages ?? []
		oauthClientOrigin = payload.oauthClientOrigin
		oauthCallbackUrl = payload.oauthCallbackUrl
		oauthClientMetadataUrl = payload.oauthClientMetadataUrl
		usageDrafts = new Map(
			payload.servers.map((server) => [
				server.id,
				{
					usageMode: server.usageMode === 'packages' ? 'packages' : 'any',
					allowedPackageIds: [...(server.allowedPackageIds ?? [])],
				},
			]),
		)
		usageSavingId = null
		deleteServerCheck.reset()
	}

	async function loadServers(signal: AbortSignal) {
		const href = getCurrentHref()
		const latchKey = getDataLatchKey(href)
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
			if (getDataLatchKey(getCurrentHref()) !== latchKey) return
			applyPayload(payload)
			// Clear a stale load-error banner; mutation success messages
			// (info tone) survive the reload.
			if (messageTone === 'error') setMessage(null)
			status = 'ready'
			loadLatch.markLoaded(latchKey)
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
			loadLatch.markFailed(latchKey)
			handle.update()
		}
	}

	async function postAction(input: {
		body: Record<string, unknown>
		successMessage: (payload: AccountMcpServersPayload) => string | null
		failureMessage: string
		afterSuccess?: (payload: AccountMcpServersPayload) => void
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
			input.afterSuccess?.(payload)
			handle.update()
		} catch (error) {
			actionState = 'idle'
			usageSavingId = null
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
		addBearerToken = String(formData.get('bearerToken') ?? '')
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
		const bearerToken = addBearerToken.trim()
		await postAction({
			body: {
				action: 'add',
				name: addName,
				url: addUrl,
				...(bearerToken ? { bearerToken } : {}),
			},
			successMessage: (payload) => {
				addName = ''
				addUrl = ''
				addBearerToken = ''
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
			afterSuccess: (payload) => {
				if (!payload.selectedServerId) return
				// Do not pre-mark the destination as loaded: `navigate` is async
				// (preload-then-commit). The commit render consumes preloaded data
				// (or the stale marker) and marks the latch itself.
				navigate(
					mcpServersRoute.buildDetailHref(
						payload.selectedServerId,
						getCurrentSearch(),
					),
				)
			},
		})
	}

	function applyRouteLoaderData(href: string) {
		if (!mcpServersRoute.isRoutePath(href)) return false
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'accountMcpServers',
			href,
		)
		if (!routeData) return false
		applyPayload(routeData)
		status = 'ready'
		loadLatch.markLoaded(getDataLatchKey(href))
		consumeOAuthResult()
		return true
	}

	function getUsageDraft(server: McpServerListItem): McpServerUsageDraft {
		return (
			usageDrafts.get(server.id) ?? {
				usageMode: server.usageMode === 'packages' ? 'packages' : 'any',
				allowedPackageIds: [...(server.allowedPackageIds ?? [])],
			}
		)
	}

	return () => {
		const currentHref = getCurrentHref()
		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const latchKey = getDataLatchKey(currentHref)
		const needsLoad = loadLatch.needsLoad({
			currentHref: latchKey,
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadServers)
		}
		const isMutating = actionState !== 'idle'
		const selection = mcpServersRoute.getSelection(currentHref)
		const search = readSearchFilter(currentHref)
		const filteredServers = filterServers(servers, search)
		const server =
			servers.find((item) => item.id === selection.selectedId) ?? null
		const showServerNotFound =
			selection.selectedId != null && !server && status === 'ready'

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="MCP servers"
					description="Connect remote MCP servers so their tools are available to Kody as kody.mcp capabilities. Use a bearer token for static Authorization, or complete OAuth when the server requires it."
					currentHref={currentHref}
					actions={
						<button
							type="button"
							disabled={isMutating}
							mix={[
								on('click', () => {
									if (isMutating) return
									deleteServerCheck.reset()
									setMessage(null)
									navigate(mcpServersRoute.buildNewHref(getCurrentSearch()))
								}),
								css(primaryButtonCss),
							]}
						>
							Add server
						</button>
					}
				/>

				{oauthCallbackUrl
					? renderOauthCallbackSection({
							oauthClientOrigin,
							oauthCallbackUrl,
							oauthClientMetadataUrl,
						})
					: null}

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading MCP servers…
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
					<RecordTable
						mode="expand"
						ariaLabel="Connected MCP servers"
						selectedId={selection.selectedId}
						recordLoading={Boolean(
							selection.selectedId &&
							!selection.isCreating &&
							!server &&
							!showServerNotFound,
						)}
						onNavigate={() => {
							deleteServerCheck.reset()
							setMessage(null)
						}}
						countLabel={`${filteredServers.length} of ${servers.length} shown`}
						emptyLabel={
							servers.length === 0
								? 'No MCP servers yet. Add one to get started.'
								: 'No servers match the current filters.'
						}
						toolbar={
							<RecordTableSearch
								label="Search servers"
								placeholder="Search servers"
								value={search}
								onInput={(value) => {
									replaceLocation(buildHrefWithUpdatedSearch(value))
								}}
							/>
						}
						columns={[
							{ key: 'name', label: 'Server', primary: true },
							{ key: 'state', label: 'State' },
							{ key: 'enabled', label: 'Enabled' },
							{ key: 'url', label: 'URL', drop: 1 },
							{ key: 'tools', label: 'Tools', align: 'end', drop: 2 },
						]}
						createRow={
							selection.isCreating
								? {
										href: isMutating
											? undefined
											: mcpServersRoute.buildNewHref(getCurrentSearch()),
										label: 'New server',
									}
								: undefined
						}
						rows={filteredServers.map((item) => ({
							id: item.id,
							// An add, toggle, or removal is in flight; the expanded
							// editor owns the selection until it settles.
							href: isMutating
								? undefined
								: mcpServersRoute.buildDetailHref(item.id, getCurrentSearch()),
							cells: {
								name: renderNamedServer(item),
								state: (
									<span mix={css({ color: stateColor(item) })}>
										{stateLabel(item)}
									</span>
								),
								enabled: (
									<RecordDot
										active={item.enabled}
										title={item.enabled ? 'Enabled' : 'Disabled'}
									/>
								),
								url: <span mix={clampedCellCss}>{item.url}</span>,
								tools: item.connected ? String(item.toolCount) : '—',
							},
						}))}
						record={
							selection.isCreating ? (
								renderAddMcpServerForm({
									addName,
									addUrl,
									addBearerToken,
									isMutating,
									isBusy: actionState === 'busy',
									primaryButtonCss,
									onSubmit: (form) => {
										void addServer(form)
									},
									onNameInput: (value) => {
										addName = value
										handle.update()
									},
									onUrlInput: (value) => {
										addUrl = value
										handle.update()
									},
									onBearerTokenInput: (value) => {
										addBearerToken = value
										handle.update()
									},
								})
							) : server ? (
								renderMcpServerDetail({
									server,
									savedPackages,
									usageDraft: getUsageDraft(server),
									usageSaving: usageSavingId === server.id,
									isMutating,
									deleteServerCheck,
									primaryButtonCss,
									secondaryButtonCss,
									dangerButtonCss,
									onUsageDraftChange: (draft) => {
										usageDrafts.set(server.id, draft)
										handle.update()
									},
									onUsageSave: () => {
										const draft = getUsageDraft(server)
										usageSavingId = server.id
										void postAction({
											body: {
												action: 'set-usage',
												id: server.id,
												usageMode: draft.usageMode,
												allowedPackageIds:
													draft.usageMode === 'packages'
														? draft.allowedPackageIds
														: [],
											},
											successMessage: () => 'Updated MCP server usage.',
											failureMessage: 'Unable to update MCP server usage.',
										})
									},
									onReconnect: () => {
										void postAction({
											body: { action: 'reconnect', id: server.id },
											successMessage: (payload) => {
												const reconnected = payload.servers.find(
													(item) => item.id === server.id,
												)
												return reconnected?.authUrl
													? 'Authorization needed. Open the new authorization link and approve access once more.'
													: 'Reconnected MCP server.'
											},
											failureMessage: 'Unable to reconnect MCP server.',
										})
									},
									onRefresh: () => {
										void postAction({
											body: { action: 'refresh', id: server.id },
											successMessage: () => 'Refreshed server tools.',
											failureMessage: 'Unable to refresh MCP server tools.',
										})
									},
									onToggleEnabled: () => {
										void postAction({
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
										})
									},
									onDelete: () => {
										void postAction({
											body: { action: 'delete', id: server.id },
											successMessage: () => 'Removed MCP server.',
											failureMessage: 'Unable to remove MCP server.',
											afterSuccess: () => {
												navigate(
													mcpServersRoute.buildListHref(getCurrentSearch()),
												)
											},
										})
									},
								})
							) : showServerNotFound ? (
								<div mix={css({ ...recordBodyCss, gap: spacing.sm })}>
									<h2
										mix={css({
											margin: 0,
											fontSize: typography.fontSize.lg,
											fontWeight: typography.fontWeight.semibold,
											color: colors.text,
										})}
									>
										Server not found
									</h2>
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										This MCP server does not exist for this account or is
										unavailable.
									</p>
								</div>
							) : null
						}
					/>
				) : null}
			</AccountManagementShell>
		)
	}
}
