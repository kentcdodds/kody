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
import { createDoubleCheck } from '#client/double-check.ts'
import { writeClipboardText } from '#client/clipboard.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
	accountInputCss,
	TimestampValue,
} from '#client/routes/account-management-components.tsx'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getAccentCalloutCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	layoutMaxWidths,
} from '#universal/styles/style-primitives.ts'
import { type AccountMcpOauthClientsLoaderData } from '#universal/loader-data.ts'

const clientsApiPath = '/account/mcp-oauth-clients.json'
const clientsPath = '/account/mcp-oauth-clients'

type CreatedClient = AccountMcpOauthClientsLoaderData['clients'][number] & {
	clientSecret: string
}

function isClientsPath(href: string) {
	return new URL(href, 'http://localhost').pathname === clientsPath
}

export async function accountMcpOauthClientsRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(clientsApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountMcpOauthClientsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load MCP OAuth clients.')
	}
	return { accountMcpOauthClients: payload }
}

export function AccountMcpOauthClientsRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let actionStatus: 'idle' | 'busy' = 'idle'
	let clients: AccountMcpOauthClientsLoaderData['clients'] = []
	let message: string | null = null
	let messageTone: 'error' | 'info' = 'info'
	let labelDraft = 'Open WebUI'
	let redirectUrisDraft = ''
	let createdClient: CreatedClient | null = null
	const loadLatch = createRouteLoadLatch()
	const revokeChecks = new Map<string, ReturnType<typeof createDoubleCheck>>()
	const primaryButtonCss = getPillButtonCss({ size: 'sm' })

	function getRevokeCheck(id: string) {
		const existing = revokeChecks.get(id)
		if (existing) return existing
		const created = createDoubleCheck(handle)
		revokeChecks.set(id, created)
		return created
	}
	const ghostButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

	async function loadClients(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		try {
			const response = await fetch(clientsApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountMcpOauthClientsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load MCP OAuth clients.')
			}
			clients = payload.clients
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
					: 'Unable to load MCP OAuth clients.'
			messageTone = 'error'
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	async function handleCreate(event: Event) {
		event.preventDefault()
		actionStatus = 'busy'
		message = null
		handle.update()
		try {
			const response = await fetch(clientsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					intent: 'create',
					label: labelDraft,
					redirectUris: redirectUrisDraft,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountMcpOauthClientsLoaderData & {
					error?: string
					createdClient?: CreatedClient
				}
			>(response)
			if (!response.ok || !payload?.ok || !payload.createdClient) {
				throw new Error(payload?.error || 'Unable to create the OAuth client.')
			}
			clients = payload.clients
			createdClient = payload.createdClient
			message =
				'Copy the client secret now. Kody does not store it after this page.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to create the OAuth client.'
			messageTone = 'error'
		} finally {
			actionStatus = 'idle'
			handle.update()
		}
	}

	async function handleRevoke(id: string) {
		actionStatus = 'busy'
		message = null
		handle.update()
		try {
			const response = await fetch(clientsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ intent: 'revoke', id }),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountMcpOauthClientsLoaderData & { error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to revoke the OAuth client.')
			}
			clients = payload.clients
			if (createdClient?.id === id) createdClient = null
			revokeChecks.get(id)?.reset()
			message = 'OAuth client revoked.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to revoke the OAuth client.'
			messageTone = 'error'
		} finally {
			actionStatus = 'idle'
			handle.update()
		}
	}

	async function copyValue(value: string, label: string) {
		try {
			await writeClipboardText(value)
			message = `Copied ${label}.`
			messageTone = 'info'
		} catch {
			message = `Unable to copy ${label}.`
			messageTone = 'error'
		}
		handle.update()
	}

	function applyRouteLoaderData(href: string) {
		if (!isClientsPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'accountMcpOauthClients',
			href,
		)
		if (!routeData) return false
		clients = routeData.clients
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
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadClients)
		}
		const isBusy = actionStatus === 'busy'

		return (
			<AccountManagementShell maxWidth={layoutMaxWidths.content}>
				<AccountPageHeader
					title="MCP OAuth clients"
					description="Pre-register a confidential client when a host cannot finish dynamic OAuth registration. Most hosts do not need this."
					currentHref={currentHref}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading MCP OAuth clients…
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
							<h2 mix={css(cardTitleCss)}>Create a client</h2>
							<p mix={css(descriptionCss)}>
								Use this for hosts such as Open WebUI that ask for a static
								Client ID and Client Secret. Prefer OAuth 2.1 dynamic
								registration when the host can open the authorize window.
							</p>
							<p mix={css(descriptionCss)}>
								Open WebUI: MCP URL{' '}
								<code mix={css(inlineCodeCss)}>https://kody.codes/mcp</code>,
								auth OAuth 2.1 (Static), OAuth Server URL{' '}
								<code mix={css(inlineCodeCss)}>https://kody.codes</code>. The
								redirect URI is{' '}
								<code mix={css(inlineCodeCss)}>
									{
										'{your-open-webui}/oauth/clients/mcp:{connection-id}/callback'
									}
								</code>
								. If the connection id is{' '}
								<code mix={css(inlineCodeCss)}>kody</code>, that path ends with{' '}
								<code mix={css(inlineCodeCss)}>mcp:kody/callback</code>.
							</p>
							<form
								mix={[
									css({
										display: 'grid',
										gap: spacing.md,
									}),
									on('submit', handleCreate),
								]}
							>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Label</span>
									<input
										data-field-ring
										type="text"
										value={labelDraft}
										maxLength={80}
										disabled={isBusy}
										mix={[
											css(accountInputCss),
											on('input', (event) => {
												labelDraft = (event.currentTarget as HTMLInputElement)
													.value
												handle.update()
											}),
										]}
									/>
								</label>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Redirect URIs</span>
									<textarea
										data-field-ring
										rows={3}
										value={redirectUrisDraft}
										disabled={isBusy}
										placeholder="https://your-open-webui/oauth/clients/mcp:kody/callback"
										mix={[
											css({
												...accountInputCss,
												minHeight: '5.5rem',
												resize: 'vertical',
											}),
											on('input', (event) => {
												redirectUrisDraft = (
													event.currentTarget as HTMLTextAreaElement
												).value
												handle.update()
											}),
										]}
									/>
								</label>
								<div>
									<button
										type="submit"
										disabled={isBusy}
										mix={css(primaryButtonCss)}
									>
										{isBusy ? 'Working…' : 'Create client'}
									</button>
								</div>
							</form>
						</section>

						{createdClient ? (
							<section
								mix={css({
									...cardCss,
									...getAccentCalloutCss(),
								})}
								aria-label="New client credentials"
							>
								<h2 mix={css(cardTitleCss)}>New client credentials</h2>
								<p mix={css(descriptionCss)}>
									Paste these into the host, then store the secret yourself.
									Kody cannot show it again.
								</p>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Client ID</span>
									<div
										mix={css({
											display: 'flex',
											gap: spacing.sm,
											alignItems: 'center',
											flexWrap: 'wrap',
										})}
									>
										<input
											data-field-ring
											type="text"
											value={createdClient.clientId}
											readOnly
											{...passwordManagerIgnoreProps}
											mix={css({
												...accountInputCss,
												flex: '1 1 16rem',
											})}
										/>
										<button
											type="button"
											mix={[
												css(ghostButtonCss),
												on('click', () => {
													void copyValue(createdClient!.clientId, 'client ID')
												}),
											]}
										>
											Copy
										</button>
									</div>
								</label>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Client secret</span>
									<div
										mix={css({
											display: 'flex',
											gap: spacing.sm,
											alignItems: 'center',
											flexWrap: 'wrap',
										})}
									>
										<input
											data-field-ring
											type="password"
											value={createdClient.clientSecret}
											readOnly
											{...passwordManagerIgnoreProps}
											mix={css({
												...accountInputCss,
												flex: '1 1 16rem',
											})}
										/>
										<button
											type="button"
											mix={[
												css(ghostButtonCss),
												on('click', () => {
													void copyValue(
														createdClient!.clientSecret,
														'client secret',
													)
												}),
											]}
										>
											Copy
										</button>
									</div>
								</label>
							</section>
						) : null}

						{clients.length === 0 ? (
							<section mix={css(cardCss)}>
								<h2 mix={css(cardTitleCss)}>No clients yet</h2>
								<p mix={css(descriptionCss)}>
									Created clients appear here. Revoking a client immediately
									stops it from exchanging tokens.
								</p>
							</section>
						) : (
							<section mix={css(cardCss)} aria-label="MCP OAuth clients">
								<h2 mix={css(cardTitleCss)}>Your clients</h2>
								<ul
									mix={css({
										listStyle: 'none',
										padding: 0,
										margin: 0,
										display: 'grid',
										gap: spacing.md,
									})}
								>
									{clients.map((client) => (
										<li
											key={client.id}
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
												<strong mix={css({ color: colors.text })}>
													{client.label}
												</strong>
												<code
													mix={css({
														...inlineCodeCss,
														overflowWrap: 'anywhere',
													})}
												>
													{client.clientId}
												</code>
												<p
													mix={css({
														...descriptionCss,
														margin: 0,
													})}
												>
													{client.redirectUris.join(' ')}
												</p>
												<p
													mix={css({
														margin: 0,
														color: colors.textMuted,
														fontSize: typography.fontSize.sm,
													})}
												>
													{client.revokedAt ? (
														<>
															Revoked{' '}
															<TimestampValue value={client.revokedAt} />
														</>
													) : (
														'Active'
													)}
													{' · '}
													Created <TimestampValue value={client.createdAt} />
												</p>
											</div>
											{client.revokedAt ? null : (
												<button
													type="button"
													disabled={isBusy}
													mix={[
														css(dangerButtonCss),
														...getRevokeCheck(client.id).getButtonMix({
															on: {
																click: () => {
																	void handleRevoke(client.id)
																},
															},
														}),
													]}
												>
													{getRevokeCheck(client.id).doubleCheck
														? 'Revoke now'
														: 'Revoke'}
												</button>
											)}
										</li>
									))}
								</ul>
							</section>
						)}
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}

const inlineCodeCss = {
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.sm,
	color: colors.text,
}
