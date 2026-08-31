import { formatTimestampDate } from '#client/format-timestamp.ts'
import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { renderIntegrationForm } from '#client/routes/admin-platform-integrations-form.tsx'
import {
	type ActionState,
	type PageStatus,
	adminPlatformIntegrationsApiPath,
	buildHrefWithUpdatedSearch,
	filterApps,
	getCurrentSearch,
	getDataKey,
	isAdminPlatformIntegrationsPath,
	parseExtraAuthorizeParams,
	platformIntegrationsRoute,
	readSearchFilter,
	splitListInput,
} from '#client/routes/admin-platform-integrations-shared.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import {
	RecordDot,
	RecordTable,
	RecordTableSearch,
	recordCellClamp,
	recordStampCss,
} from './record-table.tsx'
import {
	type AdminPlatformIntegrationApp,
	type AdminPlatformIntegrationsLoaderData,
	type AppLoaderData,
} from '#universal/loader-data.ts'

const clampedCellCss = css(recordCellClamp(28))

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
		// When editing, the URL selection is the row identity; an edited slug
		// input becomes a rename-in-place (newSlug) rather than a new row.
		// Compare canonicalized (the server does): a case-only edit is not a
		// rename.
		const inputSlug = String(formData.get('slug') ?? '').trim()
		const slug = (
			isEditing && selection.selectedId ? selection.selectedId : inputSlug
		).trim()
		const newSlug =
			isEditing &&
			inputSlug &&
			normalizeProviderKey(inputSlug) !== normalizeProviderKey(slug)
				? inputSlug
				: null
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
			...(newSlug ? { newSlug } : {}),
			clientId,
			tokenUrl,
			authorizeUrl,
			flow,
			provider: String(formData.get('provider') ?? '').trim() || null,
			label: String(formData.get('label') ?? '').trim() || null,
			description: String(formData.get('description') ?? '').trim() || null,
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
			newSlug
				? `Renamed platform integration ${slug} to ${newSlug}.`
				: isEditing
					? `Saved platform integration ${slug}.`
					: `Created platform integration ${slug}.`,
		).then((ok) => {
			if (!ok) return
			resetFormState()
			const search = getCurrentSearch(readCurrentRouterHref(handle))
			if (isEditing && !newSlug) {
				formRevision += 1
				handle.update()
				return
			}
			// Creation and rename both land on the row's (new) detail URL.
			replaceLocation(
				platformIntegrationsRoute.buildDetailHref(newSlug ?? slug, search),
			)
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
						selectedId={selection.selectedId}
						createRow={
							selection.isCreating
								? {
										href: isMutating
											? undefined
											: platformIntegrationsRoute.buildNewHref(
													getCurrentSearch(currentHref),
												),
										label: 'New integration',
									}
								: undefined
						}
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
								renderIntegrationForm({
									editingApp,
									formRevision,
									actionState,
									pendingSlug,
									removeLogoChecked,
									onSubmit: handleSaveFormSubmit,
									onLogoFileChange: handleLogoFileChange,
									onRemoveLogoChange: (checked) => {
										removeLogoChecked = checked
										if (removeLogoChecked) {
											pendingLogoBase64 = undefined
										}
										handle.update()
									},
									onToggleEnabled: handleToggleEnabled,
									onDelete: handleDelete,
									onCancel: cancelEditor,
								})
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
