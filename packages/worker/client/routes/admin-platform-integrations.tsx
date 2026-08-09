import { formatNullableTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import {
	cardCss,
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	MetadataGrid,
	accountInputCss,
	accountTextareaCss,
	verifiedPillCss,
} from './account-management-components.tsx'
import {
	type AdminPlatformIntegrationApp,
	type AdminPlatformIntegrationsLoaderData,
	type AppLoaderData,
} from '#universal/loader-data.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

const selectCss = getSelectCss()

type PageStatus = 'loading' | 'ready' | 'error'
type ActionState = 'idle' | 'saving-form' | 'toggling-enabled' | 'deleting'
type TokenExchangeStyleOption = 'default' | 'form' | 'basic-json' | 'basic-form'

const adminPlatformIntegrationsApiPath = '/admin/platform-integrations.json'

function isAdminPlatformIntegrationsPath(href: string) {
	return (
		new URL(href, 'http://localhost').pathname ===
		'/admin/platform-integrations'
	)
}

function joinList(items: Array<string>): string {
	return items.join(', ')
}

function splitListInput(raw: string): Array<string> {
	return raw
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean)
}

function formatExtraAuthorizeParams(params: Record<string, string>): string {
	return Object.entries(params)
		.map(([key, value]) => `${key}=${value}`)
		.join('\n')
}

function parseExtraAuthorizeParams(raw: string): Record<string, string> {
	const result: Record<string, string> = {}
	for (const line of raw.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed) continue
		const equalsIndex = trimmed.indexOf('=')
		if (equalsIndex === -1) continue
		const key = trimmed.slice(0, equalsIndex).trim()
		const value = trimmed.slice(equalsIndex + 1).trim()
		if (key) result[key] = value
	}
	return result
}

function formatTokenExchangeStyle(
	value: AdminPlatformIntegrationApp['tokenExchangeStyle'],
): TokenExchangeStyleOption {
	if (value === 'form' || value === 'basic-json' || value === 'basic-form') {
		return value
	}
	return 'default'
}

function enabledPillCss(enabled: boolean) {
	return enabled
		? verifiedPillCss
		: {
				...verifiedPillCss,
				color: colors.textMuted,
				backgroundColor: colors.border,
			}
}

export async function adminPlatformIntegrationsRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(adminPlatformIntegrationsApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view platform integrations.')
	}
	const payload = await readJson<AdminPlatformIntegrationsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load platform integrations.')
	}
	return { adminPlatformIntegrations: payload } as RouteLoaderResult
}

export function AdminPlatformIntegrationsRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let apps: Array<AdminPlatformIntegrationApp> = []
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let actionState: ActionState = 'idle'
	/** Slug of the card an action is running against, for per-card labels. */
	let pendingSlug: string | null = null
	let lastLoadedHref = ''
	let loadingForHref: string | null = null
	let lastFailedHref: string | null = null
	let loadRequestId = 0
	let editingApp: AdminPlatformIntegrationApp | null = null
	let pendingLogoBase64: string | undefined = undefined
	let removeLogoChecked = false

	function applyData(payload: AdminPlatformIntegrationsLoaderData) {
		apps = payload.apps
		status = 'ready'
		message = null
		messageTone = 'info'
	}

	function resetFormState() {
		editingApp = null
		pendingLogoBase64 = undefined
		removeLogoChecked = false
	}

	async function loadPlatformIntegrations() {
		const href = readCurrentRouterHref(handle)
		loadingForHref = href
		const requestId = ++loadRequestId
		try {
			const response = await fetch(adminPlatformIntegrationsApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (requestId !== loadRequestId) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			if (response.status === 403) {
				status = 'error'
				message = 'You do not have permission to view platform integrations.'
				messageTone = 'error'
				lastFailedHref = href
				handle.update()
				return
			}
			const payload =
				await readJson<AdminPlatformIntegrationsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load platform integrations.')
			}
			applyData(payload)
			lastLoadedHref = href
			lastFailedHref = null
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load platform integrations.'
			messageTone = 'error'
			lastFailedHref = href
			handle.update()
		} finally {
			if (requestId === loadRequestId) loadingForHref = null
		}
	}

	async function submitAdminAction(
		body: Record<string, unknown>,
		nextActionState: Exclude<ActionState, 'idle'>,
		successMessage: string,
	): Promise<boolean> {
		actionState = nextActionState
		pendingSlug = typeof body.slug === 'string' ? body.slug : null
		message = null
		messageTone = 'info'
		handle.update()
		try {
			const response = await fetch(adminPlatformIntegrationsApiPath, {
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
				return false
			}
			const payload = await readJson<
				AdminPlatformIntegrationsLoaderData & {
					ok?: boolean
					error?: string
				}
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(
					payload?.error ?? 'Unable to update platform integrations.',
				)
			}
			applyData(payload)
			message = successMessage
			messageTone = 'info'
			return true
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to update platform integrations.'
			messageTone = 'error'
			return false
		} finally {
			actionState = 'idle'
			pendingSlug = null
			handle.update()
		}
	}

	function handleLogoFileChange(event: Event) {
		const input = event.currentTarget
		if (!(input instanceof HTMLInputElement)) return
		const file = input.files?.[0]
		if (!file) {
			pendingLogoBase64 = undefined
			handle.update()
			return
		}
		removeLogoChecked = false
		const reader = new FileReader()
		reader.onload = () => {
			if (typeof reader.result !== 'string') return
			const commaIndex = reader.result.indexOf(',')
			pendingLogoBase64 =
				commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result
			handle.update()
		}
		reader.readAsDataURL(file)
	}

	function handleSaveFormSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget
		const formData = new FormData(form)
		// FormData excludes disabled controls, so the locked slug input must
		// come from the editing state when editing.
		const slug = (editingApp?.slug ?? String(formData.get('slug') ?? '')).trim()
		const clientId = String(formData.get('clientId') ?? '').trim()
		const tokenUrl = String(formData.get('tokenUrl') ?? '').trim()
		const authorizeUrl = String(formData.get('authorizeUrl') ?? '').trim()
		const flow = String(formData.get('flow') ?? '').trim()
		if (!slug || !clientId || !tokenUrl || !authorizeUrl) {
			message = 'Slug, client id, token URL, and authorize URL are required.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (flow !== 'pkce' && flow !== 'confidential') {
			message = 'Choose a valid OAuth flow.'
			messageTone = 'error'
			handle.update()
			return
		}

		const body: Record<string, unknown> = {
			action: 'save',
			slug,
			clientId,
			tokenUrl,
			authorizeUrl,
			flow,
			provider: String(formData.get('provider') ?? '').trim() || null,
			label: String(formData.get('label') ?? '').trim() || null,
			apiBaseUrl: String(formData.get('apiBaseUrl') ?? '').trim() || null,
			scopeSeparator:
				String(formData.get('scopeSeparator') ?? '').trim() || null,
			enabled: formData.get('enabled') === 'on',
			allowedScopes: splitListInput(
				String(formData.get('allowedScopes') ?? ''),
			),
			defaultScopes: splitListInput(
				String(formData.get('defaultScopes') ?? ''),
			),
			requiredHosts: splitListInput(
				String(formData.get('requiredHosts') ?? ''),
			),
			extraAuthorizeParams: parseExtraAuthorizeParams(
				String(formData.get('extraAuthorizeParams') ?? ''),
			),
		}

		// Always include the key: the handler maps non-literal values (the
		// "default" option) to null, which clears a stored style — omitting
		// the key would retain it instead.
		body.tokenExchangeStyle = String(
			formData.get('tokenExchangeStyle') ?? 'default',
		)

		const clientSecret = String(formData.get('clientSecret') ?? '').trim()
		if (clientSecret) {
			body.clientSecret = clientSecret
		}

		if (removeLogoChecked) {
			body.logoBase64 = ''
		} else if (pendingLogoBase64 !== undefined) {
			body.logoBase64 = pendingLogoBase64
		}

		const isEditing = editingApp !== null
		void submitAdminAction(
			body,
			'saving-form',
			isEditing
				? `Saved platform integration ${slug}.`
				: `Created platform integration ${slug}.`,
		).then((ok) => {
			if (!ok) return
			form.reset()
			resetFormState()
			handle.update()
		})
	}

	function handleToggleEnabled(app: AdminPlatformIntegrationApp) {
		void submitAdminAction(
			{
				action: 'save',
				slug: app.slug,
				clientId: app.clientId,
				tokenUrl: app.tokenUrl,
				authorizeUrl: app.authorizeUrl,
				flow: app.flow,
				enabled: !app.enabled,
			},
			'toggling-enabled',
			`${app.enabled ? 'Disabled' : 'Enabled'} ${app.slug}.`,
		)
	}

	function handleDelete(app: AdminPlatformIntegrationApp) {
		void submitAdminAction(
			{
				action: 'delete',
				slug: app.slug,
			},
			'deleting',
			`Deleted platform integration ${app.slug}.`,
		).then((ok) => {
			if (!ok) return
			if (editingApp?.slug === app.slug) {
				resetFormState()
				handle.update()
			}
		})
	}

	function handleEdit(app: AdminPlatformIntegrationApp) {
		editingApp = app
		pendingLogoBase64 = undefined
		removeLogoChecked = false
		handle.update()
	}

	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const routeData = isAdminPlatformIntegrationsPath(currentHref)
			? (tryConsumeRouteLoaderData(
					handle,
					'adminPlatformIntegrations' as keyof AppLoaderData,
					currentHref,
				) as AdminPlatformIntegrationsLoaderData | undefined)
			: undefined
		if (routeData) {
			applyData(routeData)
			lastLoadedHref = currentHref
			lastFailedHref = null
		}
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !routeData
		const needsLoad =
			(status === 'loading' ||
				currentHref !== lastLoadedHref ||
				needsStaleRefresh) &&
			currentHref !== lastFailedHref &&
			loadingForHref !== currentHref
		if (!routeData && needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			loadingForHref = currentHref
			handle.queueTask(loadPlatformIntegrations)
		}
		const isMutating = actionState !== 'idle'
		const isEditing = editingApp !== null
		const formKey =
			isEditing && editingApp ? `edit-${editingApp.slug}` : 'create'

		return (
			<AccountManagementShell>
				<AdminPageHeader
					title="Admin platform integrations"
					description="Manage operator-provisioned OAuth apps stored in the platform_oauth_apps table."
					currentHref={currentHref}
				/>
				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading platform integrations…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				<div mix={css({ display: 'grid', gap: spacing.lg })}>
					{apps.map((app) => (
						<section
							key={`${app.slug}:${app.updatedAt}:${app.connectionCount}`}
							mix={css(cardCss)}
						>
							<div
								mix={css({
									display: 'flex',
									justifyContent: 'space-between',
									gap: spacing.md,
									flexWrap: 'wrap',
									alignItems: 'flex-start',
									marginBottom: spacing.md,
								})}
							>
								<div
									mix={css({
										display: 'flex',
										gap: spacing.md,
										alignItems: 'flex-start',
										minWidth: 0,
									})}
								>
									{app.logoPath ? (
										<img
											src={app.logoPath}
											alt=""
											width={32}
											height={32}
											mix={css({
												width: '32px',
												height: '32px',
												borderRadius: '0.5rem',
												objectFit: 'contain',
												flexShrink: 0,
											})}
										/>
									) : (
										<div
											aria-hidden="true"
											mix={css({
												width: '32px',
												height: '32px',
												borderRadius: '0.5rem',
												background: colors.border,
												flexShrink: 0,
											})}
										/>
									)}
									<div mix={css({ minWidth: 0 })}>
										<div
											mix={css({
												display: 'flex',
												flexWrap: 'wrap',
												gap: spacing.sm,
												alignItems: 'center',
											})}
										>
											<h2
												mix={css({
													fontSize: typography.fontSize.lg,
													fontWeight: typography.fontWeight.semibold,
													margin: 0,
												})}
											>
												<code mix={css({ fontSize: typography.fontSize.base })}>
													{app.slug}
												</code>
											</h2>
											<span mix={css(enabledPillCss(app.enabled))}>
												{app.enabled ? 'Enabled' : 'Disabled'}
											</span>
										</div>
										<p mix={css({ margin: 0, color: colors.textMuted })}>
											{app.provider}
											{app.label ? ` · ${app.label}` : ''} ·{' '}
											{app.connectionCount} connection
											{app.connectionCount === 1 ? '' : 's'}
										</p>
									</div>
								</div>
								<div
									mix={css({
										display: 'flex',
										flexWrap: 'wrap',
										gap: spacing.sm,
									})}
								>
									<button
										type="button"
										disabled={isMutating}
										mix={[
											on('click', () => handleToggleEnabled(app)),
											css(secondaryButtonCss),
										]}
									>
										{actionState === 'toggling-enabled' &&
										pendingSlug === app.slug
											? 'Saving…'
											: app.enabled
												? 'Disable'
												: 'Enable'}
									</button>
									<button
										type="button"
										disabled={isMutating}
										mix={[
											on('click', () => handleEdit(app)),
											css(secondaryButtonCss),
										]}
									>
										Edit
									</button>
									<button
										type="button"
										disabled={isMutating}
										mix={[
											on('click', () => handleDelete(app)),
											css(dangerButtonCss),
										]}
									>
										{actionState === 'deleting' && pendingSlug === app.slug
											? 'Deleting…'
											: 'Delete'}
									</button>
								</div>
							</div>
							<MetadataGrid
								items={[
									{
										label: 'Client id',
										value: app.clientId,
									},
									{
										label: 'Client secret',
										value: app.hasClientSecret ? 'secret stored' : 'no secret',
									},
									{
										label: 'Flow',
										value: app.flow,
									},
									{
										label: 'Token exchange',
										value: app.tokenExchangeStyle ?? 'default',
									},
									{
										label: 'Token URL',
										value: app.tokenUrl,
									},
									{
										label: 'Authorize URL',
										value: app.authorizeUrl,
									},
									{
										label: 'API base URL',
										value: app.apiBaseUrl ?? 'None',
									},
									{
										label: 'Allowed scopes',
										value: joinList(app.allowedScopes) || 'None',
									},
									{
										label: 'Default scopes',
										value: joinList(app.defaultScopes) || 'None',
									},
									{
										label: 'Required hosts',
										value: joinList(app.requiredHosts) || 'None',
									},
									{
										label: 'Updated',
										value: formatNullableTimestamp(app.updatedAt),
									},
								]}
							/>
						</section>
					))}
				</div>
				<AccountManagementPanel
					title={isEditing ? 'Edit integration' : 'Create integration'}
					description="Save creates or updates a platform OAuth app. Omitted write-only fields retain stored values."
					asForm
					onSubmit={handleSaveFormSubmit}
				>
					<div key={formKey} mix={css({ display: 'grid', gap: spacing.md })}>
						<div
							mix={css({
								display: 'grid',
								gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
								gap: spacing.md,
								[mq.mobile]: {
									gridTemplateColumns: 'minmax(0, 1fr)',
								},
							})}
						>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Slug</span>
								<input
									data-field-ring
									name="slug"
									type="text"
									required
									disabled={isMutating || isEditing}
									defaultValue={editingApp?.slug ?? ''}
									mix={css(accountInputCss)}
								/>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Provider</span>
								<input
									data-field-ring
									name="provider"
									type="text"
									disabled={isMutating}
									defaultValue={editingApp?.provider ?? ''}
									mix={css(accountInputCss)}
								/>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Label</span>
								<input
									data-field-ring
									name="label"
									type="text"
									disabled={isMutating}
									defaultValue={editingApp?.label ?? ''}
									mix={css(accountInputCss)}
								/>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Client id</span>
								<input
									data-field-ring
									name="clientId"
									type="text"
									required
									disabled={isMutating}
									defaultValue={editingApp?.clientId ?? ''}
									mix={css(accountInputCss)}
								/>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Client secret</span>
								<input
									data-field-ring
									name="clientSecret"
									type="password"
									autoComplete="new-password"
									placeholder="unchanged when empty"
									disabled={isMutating}
									mix={css(accountInputCss)}
								/>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Flow</span>
								<select
									data-field-ring
									name="flow"
									required
									disabled={isMutating}
									mix={css(selectCss)}
								>
									{/* Explicit per-option selection: this renderer applies
									    defaultValue as an attribute, which selects ignore. */}
									<option
										value="pkce"
										selected={(editingApp?.flow ?? 'pkce') === 'pkce'}
									>
										pkce
									</option>
									<option
										value="confidential"
										selected={editingApp?.flow === 'confidential'}
									>
										confidential
									</option>
								</select>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Token exchange style</span>
								<select
									data-field-ring
									name="tokenExchangeStyle"
									disabled={isMutating}
									mix={css(selectCss)}
								>
									{(
										['default', 'form', 'basic-json', 'basic-form'] as const
									).map((style) => (
										<option
											key={style}
											value={style}
											selected={
												formatTokenExchangeStyle(
													editingApp?.tokenExchangeStyle ?? null,
												) === style
											}
										>
											{style}
										</option>
									))}
								</select>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Scope separator</span>
								<input
									data-field-ring
									name="scopeSeparator"
									type="text"
									disabled={isMutating}
									defaultValue={editingApp?.scopeSeparator ?? ''}
									mix={css(accountInputCss)}
								/>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Token URL</span>
								<input
									data-field-ring
									name="tokenUrl"
									type="url"
									required
									disabled={isMutating}
									defaultValue={editingApp?.tokenUrl ?? ''}
									mix={css(accountInputCss)}
								/>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Authorize URL</span>
								<input
									data-field-ring
									name="authorizeUrl"
									type="url"
									required
									disabled={isMutating}
									defaultValue={editingApp?.authorizeUrl ?? ''}
									mix={css(accountInputCss)}
								/>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>API base URL</span>
								<input
									data-field-ring
									name="apiBaseUrl"
									type="url"
									disabled={isMutating}
									defaultValue={editingApp?.apiBaseUrl ?? ''}
									mix={css(accountInputCss)}
								/>
							</label>
						</div>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Allowed scopes</span>
							<input
								data-field-ring
								name="allowedScopes"
								type="text"
								disabled={isMutating}
								placeholder="Comma or whitespace separated"
								defaultValue={joinList(editingApp?.allowedScopes ?? [])}
								mix={css(accountInputCss)}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Default scopes</span>
							<input
								data-field-ring
								name="defaultScopes"
								type="text"
								disabled={isMutating}
								placeholder="Comma or whitespace separated"
								defaultValue={joinList(editingApp?.defaultScopes ?? [])}
								mix={css(accountInputCss)}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Required hosts</span>
							<input
								data-field-ring
								name="requiredHosts"
								type="text"
								disabled={isMutating}
								placeholder="Comma or whitespace separated"
								defaultValue={joinList(editingApp?.requiredHosts ?? [])}
								mix={css(accountInputCss)}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Extra authorize params</span>
							<textarea
								data-field-ring
								name="extraAuthorizeParams"
								disabled={isMutating}
								placeholder="key=value (one per line)"
								defaultValue={formatExtraAuthorizeParams(
									editingApp?.extraAuthorizeParams ?? {},
								)}
								mix={css(accountTextareaCss)}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Logo</span>
							<input
								data-field-ring
								name="logo"
								type="file"
								accept="image/svg+xml,image/png,image/jpeg,image/webp"
								disabled={isMutating}
								mix={[on('change', handleLogoFileChange), css(accountInputCss)]}
							/>
						</label>
						{isEditing && editingApp?.logoPath ? (
							<label
								mix={css({
									...fieldCss,
									display: 'flex',
									flexDirection: 'row',
									alignItems: 'center',
									gap: spacing.sm,
								})}
							>
								<input
									name="removeLogo"
									type="checkbox"
									checked={removeLogoChecked}
									disabled={isMutating}
									mix={[
										css({
											width: '1.25rem',
											height: '1.25rem',
											accentColor: colors.primary,
										}),
										on('change', (event) => {
											const input = event.currentTarget
											if (!(input instanceof HTMLInputElement)) return
											removeLogoChecked = input.checked
											if (removeLogoChecked) {
												pendingLogoBase64 = undefined
											}
											handle.update()
										}),
									]}
								/>
								<span mix={css(fieldLabelCss)}>Remove logo</span>
							</label>
						) : null}
						<label
							mix={css({
								...fieldCss,
								display: 'flex',
								flexDirection: 'row',
								alignItems: 'center',
								gap: spacing.sm,
							})}
						>
							<input
								name="enabled"
								type="checkbox"
								defaultChecked={editingApp?.enabled ?? true}
								disabled={isMutating}
								mix={css({
									width: '1.25rem',
									height: '1.25rem',
									accentColor: colors.primary,
								})}
							/>
							<span mix={css(fieldLabelCss)}>Enabled</span>
						</label>
						<div
							mix={css({
								display: 'flex',
								flexWrap: 'wrap',
								gap: spacing.sm,
								alignItems: 'center',
							})}
						>
							<button
								type="submit"
								disabled={isMutating}
								mix={css(primaryButtonCss)}
							>
								{actionState === 'saving-form'
									? 'Saving…'
									: isEditing
										? 'Save changes'
										: 'Create integration'}
							</button>
							{isEditing ? (
								<button
									type="button"
									disabled={isMutating}
									mix={[
										on('click', () => {
											resetFormState()
											handle.update()
										}),
										css(secondaryButtonCss),
									]}
								>
									Cancel edit
								</button>
							) : null}
						</div>
					</div>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
