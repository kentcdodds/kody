import { formatTimestampDate } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { matchesSearchQuery } from '#client/search-filter.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getLogoWellCss,
	getPillButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
	accountInputCss,
	accountTextareaCss,
} from './account-management-components.tsx'
import {
	RecordDot,
	RecordTable,
	RecordTableSearch,
	recordBodyCss,
	recordCellClamp,
	recordStampCss,
} from './record-table.tsx'
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
const clampedCellCss = css(recordCellClamp(28))

const adminPlatformIntegrationsApiPath = '/admin/platform-integrations.json'
const platformIntegrationsRoute = createListDetailRoute(
	'/admin/platform-integrations',
)
const createRecordId = '__new__'

type PageStatus = 'loading' | 'ready' | 'error'
type ActionState = 'idle' | 'saving-form' | 'toggling-enabled' | 'deleting'
type TokenExchangeStyleOption = 'default' | 'form' | 'basic-json' | 'basic-form'

function isAdminPlatformIntegrationsPath(href: string) {
	return platformIntegrationsRoute.isRoutePath(href)
}

function readSearchFilter(href: string) {
	return new URL(href, 'http://localhost').searchParams.get('q')?.trim() ?? ''
}

/**
 * Search is client-side over the already-loaded apps list. Loading keys on
 * pathname only so typing in `q` does not refetch or unmount the table.
 */
function getDataKey(href: string) {
	return new URL(href, 'http://localhost').pathname
}

function getCurrentSearch(href: string) {
	return new URL(href, 'http://localhost').search
}

function buildHrefWithUpdatedSearch(href: string, search: string) {
	const nextUrl = new URL(href, 'http://localhost')
	if (search) nextUrl.searchParams.set('q', search)
	else nextUrl.searchParams.delete('q')
	return `${nextUrl.pathname}${nextUrl.search}`
}

function filterApps(apps: Array<AdminPlatformIntegrationApp>, search: string) {
	return apps.filter((app) =>
		matchesSearchQuery(search, [app.slug, app.provider, app.label]),
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
	/** Slug of the row an action is running against, for per-row labels. */
	let pendingSlug: string | null = null
	let lastLoadedDataKey = ''
	let loadingDataKey: string | null = null
	let lastFailedDataKey: string | null = null
	let loadRequestId = 0
	let pendingLogoBase64: string | undefined = undefined
	let removeLogoChecked = false
	/** Bumped after a successful edit save so uncontrolled fields remount. */
	let formRevision = 0

	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

	function applyData(payload: AdminPlatformIntegrationsLoaderData) {
		apps = payload.apps
		status = 'ready'
		message = null
		messageTone = 'info'
	}

	function resetFormState() {
		pendingLogoBase64 = undefined
		removeLogoChecked = false
	}

	function resetSelectionState() {
		resetFormState()
		message = null
		messageTone = 'info'
	}

	async function loadPlatformIntegrations() {
		const href = readCurrentRouterHref(handle)
		const dataKey = getDataKey(href)
		loadingDataKey = dataKey
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
				lastFailedDataKey = dataKey
				handle.update()
				return
			}
			const payload =
				await readJson<AdminPlatformIntegrationsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load platform integrations.')
			}
			applyData(payload)
			lastLoadedDataKey = dataKey
			lastFailedDataKey = null
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load platform integrations.'
			messageTone = 'error'
			lastFailedDataKey = dataKey
			handle.update()
		} finally {
			if (requestId === loadRequestId) loadingDataKey = null
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
		const selection = platformIntegrationsRoute.getSelection(
			readCurrentRouterHref(handle),
		)
		const isEditing = !selection.isCreating && selection.selectedId != null
		// FormData excludes disabled controls, so the locked slug input must
		// come from the URL selection when editing.
		const slug = (
			isEditing && selection.selectedId
				? selection.selectedId
				: String(formData.get('slug') ?? '')
		).trim()
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

		void submitAdminAction(
			body,
			'saving-form',
			isEditing
				? `Saved platform integration ${slug}.`
				: `Created platform integration ${slug}.`,
		).then((ok) => {
			if (!ok) return
			resetFormState()
			const search = getCurrentSearch(readCurrentRouterHref(handle))
			if (isEditing) {
				formRevision += 1
				handle.update()
				return
			}
			replaceLocation(platformIntegrationsRoute.buildDetailHref(slug, search))
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
			const href = readCurrentRouterHref(handle)
			const selection = platformIntegrationsRoute.getSelection(href)
			const search = getCurrentSearch(href)
			resetFormState()
			if (selection.selectedId === app.slug || selection.isCreating) {
				replaceLocation(platformIntegrationsRoute.buildListHref(search))
			}
			handle.update()
		})
	}

	function cancelEditor() {
		const search = getCurrentSearch(readCurrentRouterHref(handle))
		resetSelectionState()
		replaceLocation(platformIntegrationsRoute.buildListHref(search))
		handle.update()
	}

	function startCreateIntegration() {
		if (actionState !== 'idle') return
		const search = getCurrentSearch(readCurrentRouterHref(handle))
		resetSelectionState()
		replaceLocation(platformIntegrationsRoute.buildNewHref(search))
		handle.update()
	}

	function renderIntegrationForm(
		editingApp: AdminPlatformIntegrationApp | null,
	) {
		const isEditing = editingApp != null
		const formKey =
			isEditing && editingApp
				? `edit-${editingApp.slug}:${formRevision}`
				: `create:${formRevision}`

		return (
			<form
				key={formKey}
				method="post"
				noValidate
				mix={[on('submit', handleSaveFormSubmit), css(recordBodyCss)]}
			>
				<div
					mix={css({
						display: 'flex',
						justifyContent: 'space-between',
						gap: spacing.md,
						flexWrap: 'wrap',
						alignItems: 'flex-start',
					})}
				>
					<div mix={css({ display: 'grid', gap: spacing.xs, minWidth: 0 })}>
						<h2 mix={css(cardTitleCss)}>
							{isEditing ? 'Edit integration' : 'Create integration'}
						</h2>
						<p mix={css(descriptionCss)}>
							Save creates or updates a platform OAuth app. Omitted write-only
							fields retain stored values.
						</p>
					</div>
					{isEditing && editingApp ? (
						<div
							mix={css({
								display: 'flex',
								flexWrap: 'wrap',
								gap: spacing.sm,
							})}
						>
							<button
								type="button"
								disabled={actionState !== 'idle'}
								mix={[
									on('click', () => handleToggleEnabled(editingApp)),
									css(secondaryButtonCss),
								]}
							>
								{actionState === 'toggling-enabled' &&
								pendingSlug === editingApp.slug
									? 'Saving…'
									: editingApp.enabled
										? 'Disable'
										: 'Enable'}
							</button>
							<button
								type="button"
								disabled={actionState !== 'idle'}
								mix={[
									on('click', () => handleDelete(editingApp)),
									css(dangerButtonCss),
								]}
							>
								{actionState === 'deleting' && pendingSlug === editingApp.slug
									? 'Deleting…'
									: 'Delete'}
							</button>
						</div>
					) : null}
				</div>

				<div mix={css({ display: 'grid', gap: spacing.md })}>
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
								disabled={actionState !== 'idle' || isEditing}
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
								disabled={actionState !== 'idle'}
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
								disabled={actionState !== 'idle'}
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
								disabled={actionState !== 'idle'}
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
								disabled={actionState !== 'idle'}
								mix={css(accountInputCss)}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Flow</span>
							<select
								data-field-ring
								name="flow"
								required
								disabled={actionState !== 'idle'}
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
								disabled={actionState !== 'idle'}
								mix={css(selectCss)}
							>
								{(['default', 'form', 'basic-json', 'basic-form'] as const).map(
									(style) => (
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
									),
								)}
							</select>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Scope separator</span>
							<input
								data-field-ring
								name="scopeSeparator"
								type="text"
								disabled={actionState !== 'idle'}
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
								disabled={actionState !== 'idle'}
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
								disabled={actionState !== 'idle'}
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
								disabled={actionState !== 'idle'}
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
							disabled={actionState !== 'idle'}
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
							disabled={actionState !== 'idle'}
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
							disabled={actionState !== 'idle'}
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
							disabled={actionState !== 'idle'}
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
							disabled={actionState !== 'idle'}
							mix={[on('change', handleLogoFileChange), css(accountInputCss)]}
						/>
					</label>
					{isEditing && editingApp?.logoPath ? (
						<div
							mix={css({
								display: 'flex',
								alignItems: 'center',
								gap: spacing.md,
								flexWrap: 'wrap',
							})}
						>
							<span
								mix={css(getLogoWellCss({ size: '2.5rem', radius: '10px' }))}
							>
								<img
									src={editingApp.logoPath}
									alt=""
									width={32}
									height={32}
									mix={css({
										display: 'block',
										width: '1.75rem',
										height: '1.75rem',
										objectFit: 'contain',
									})}
								/>
							</span>
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
									disabled={actionState !== 'idle'}
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
						</div>
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
							disabled={actionState !== 'idle'}
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
							disabled={actionState !== 'idle'}
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
								disabled={actionState !== 'idle'}
								mix={[on('click', cancelEditor), css(secondaryButtonCss)]}
							>
								Cancel edit
							</button>
						) : (
							<button
								type="button"
								disabled={actionState !== 'idle'}
								mix={[on('click', cancelEditor), css(secondaryButtonCss)]}
							>
								Cancel
							</button>
						)}
					</div>
				</div>
			</form>
		)
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const currentDataKey = getDataKey(currentHref)
		const routeData = isAdminPlatformIntegrationsPath(currentHref)
			? (tryConsumeRouteLoaderData(
					handle,
					'adminPlatformIntegrations' as keyof AppLoaderData,
					currentHref,
				) as AdminPlatformIntegrationsLoaderData | undefined)
			: undefined
		if (routeData) {
			applyData(routeData)
			lastLoadedDataKey = currentDataKey
			lastFailedDataKey = null
		}
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !routeData
		const needsLoad =
			(status === 'loading' ||
				currentDataKey !== lastLoadedDataKey ||
				needsStaleRefresh) &&
			currentDataKey !== lastFailedDataKey &&
			loadingDataKey !== currentDataKey
		if (!routeData && needsLoad && typeof document !== 'undefined') {
			// Keep the table mounted during search/selection navigations; only
			// show the page-level loading line on the first fetch.
			if (lastLoadedDataKey === '') {
				status = 'loading'
			}
			loadingDataKey = currentDataKey
			handle.queueTask(loadPlatformIntegrations)
		}

		const selection = platformIntegrationsRoute.getSelection(currentHref)
		const search = readSearchFilter(currentHref)
		const filteredApps = filterApps(apps, search)
		const editingApp = selection.isCreating
			? null
			: (apps.find((app) => app.slug === selection.selectedId) ?? null)
		const isMutating = actionState !== 'idle'
		const showEditor = selection.isCreating || editingApp != null
		const showNotFound =
			selection.selectedId != null &&
			!selection.isCreating &&
			editingApp == null &&
			status === 'ready'
		const tableSelectedId = selection.isCreating
			? createRecordId
			: selection.selectedId

		return (
			<AccountManagementShell>
				<AdminPageHeader
					title="Admin platform integrations"
					description="Manage operator-provisioned OAuth apps stored in the platform_oauth_apps table."
					currentHref={currentHref}
				/>
				{status === 'loading' && lastLoadedDataKey === '' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading platform integrations…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				{status === 'ready' || lastLoadedDataKey !== '' ? (
					<RecordTable
						mode="expand"
						busy={status === 'loading'}
						ariaLabel="Platform integrations"
						selectedId={tableSelectedId}
						onNavigate={() => {
							resetSelectionState()
						}}
						countLabel={`${filteredApps.length} of ${apps.length} integrations`}
						emptyLabel={
							apps.length === 0
								? 'No platform integrations yet. Create one to get started.'
								: 'No integrations match the current search.'
						}
						toolbar={
							<>
								<RecordTableSearch
									label="Search integrations"
									placeholder="Search slug, provider, or label"
									value={search}
									onInput={(value) => {
										replaceLocation(
											buildHrefWithUpdatedSearch(currentHref, value),
										)
									}}
								/>
								<button
									type="button"
									disabled={isMutating}
									mix={[
										on('click', startCreateIntegration),
										css(primaryButtonCss),
									]}
								>
									Create integration
								</button>
							</>
						}
						columns={[
							{ key: 'slug', label: 'Slug', primary: true },
							{ key: 'provider', label: 'Provider' },
							{ key: 'label', label: 'Label', drop: 1 },
							{ key: 'enabled', label: 'Enabled' },
							{
								key: 'connections',
								label: 'Connections',
								align: 'end',
								drop: 2,
							},
							{ key: 'updated', label: 'Updated', drop: 3 },
						]}
						rows={filteredApps.map((app) => ({
							id: app.slug,
							href: isMutating
								? undefined
								: platformIntegrationsRoute.buildDetailHref(
										app.slug,
										new URL(currentHref, 'http://localhost').search,
									),
							cells: {
								slug: (
									<code
										mix={css({
											fontSize: typography.fontSize.sm,
											...recordCellClamp(24),
										})}
									>
										{app.slug}
									</code>
								),
								provider: (
									<span mix={clampedCellCss}>{app.provider || '—'}</span>
								),
								label: <span mix={clampedCellCss}>{app.label || '—'}</span>,
								enabled: (
									<RecordDot
										active={app.enabled}
										title={app.enabled ? 'Enabled' : 'Disabled'}
									/>
								),
								connections: String(app.connectionCount),
								updated: (
									<span mix={css(recordStampCss)}>
										{formatTimestampDate(app.updatedAt)}
									</span>
								),
							},
						}))}
						record={
							showEditor ? (
								renderIntegrationForm(editingApp)
							) : showNotFound ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Platform integration not found.
								</p>
							) : null
						}
					/>
				) : null}
			</AccountManagementShell>
		)
	}
}
