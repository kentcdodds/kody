import {
	type AccountSecretDetail,
	type AccountSecretListItem,
	type AccountSecretsLoaderData,
} from '#universal/loader-data.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { buildAccountSecretPath } from '@kody-internal/shared/account-secret-route.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { type ListDetailSelection } from '#client/list-detail-route.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { createDoubleCheck } from '#client/double-check.ts'
import {
	type AccountStatus,
	type ApprovalAction,
	type ApprovalView,
	accountSecretsApiPath,
	getScopeLabel,
	readJson,
	submitApprovalRequest,
} from '#client/routes/account-approval-shared.ts'
import { Combobox } from '#client/combobox.tsx'
import { colors } from '#universal/styles/tokens.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
import { getNewSecretValueAutofocusKey } from './new-secret-query.ts'
import { normalizeAllowedHosts } from './secret-normalization.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import {
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordCellClamp,
	recordStampCss,
} from './record-table.tsx'
import {
	renderAlreadyAddedNotice,
	renderSecretApprovalCard,
} from './account-secrets-approval.tsx'
import { renderSecretEditor } from './account-secrets-editor.tsx'
import {
	type PackageOption,
	type SecretFilterScope,
	accountSecretsRouteLoader,
	buildBaseSecretsHref,
	buildNewSecretHref,
	buildSecretHref,
	buildSecretsApiRequestUrl,
	collectRepeatedTextRows,
	createEditorStateFromNewSecretQuery,
	createEditorStateFromSecret,
	createEmptyEditorState,
	filterSecrets,
	formatRelativeTtl,
	getAlreadyAddedNotice,
	getDataRefreshKey,
	readFilterState,
	secretsBasePath,
	secretsRoute,
} from './account-secrets-shared.ts'

export { accountSecretsRouteLoader }

const clampedCellCss = css(recordCellClamp(26))

export function AccountSecretsRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let packageOptions: Array<PackageOption> = []
	let packagesById = new Map<string, { kodyId: string; name: string }>()
	let secrets: Array<AccountSecretListItem> = []
	let selectedSecret: AccountSecretDetail | null = null
	let approval: ApprovalView | null = null
	let editorState = createEmptyEditorState([])
	let message: string | null = null
	let submittingApprovalAction: ApprovalAction | null = null
	let saveState: 'idle' | 'saving' | 'deleting' = 'idle'
	let lastLoadedDataKey = ''
	let lastFailedDataKey: string | null = null
	let loadingDataKey: string | null = null
	let loadRequestId = 0
	let retryTimeout: ReturnType<typeof setTimeout> | null = null
	let showSecretValue = false
	const deleteSecretCheck = createDoubleCheck(handle)

	function getCurrentHref() {
		return readCurrentRouterHref(handle)
	}

	function getCurrentSearch() {
		return new URL(getCurrentHref(), 'http://localhost').search
	}

	function buildHrefWithUpdatedFilters(
		nextFilters: Partial<ReturnType<typeof readFilterState>>,
		options?: { pathname?: string },
	) {
		const currentUrl = new URL(getCurrentHref(), 'http://localhost')
		const filters = {
			...readFilterState(currentUrl.toString(), packageOptions),
			...nextFilters,
		}
		const nextUrl = new URL(currentUrl.toString())
		if (options?.pathname) {
			nextUrl.pathname = options.pathname
		}
		if (filters.search) nextUrl.searchParams.set('q', filters.search)
		else nextUrl.searchParams.delete('q')
		if (filters.scope === 'all') nextUrl.searchParams.delete('scope')
		else nextUrl.searchParams.set('scope', filters.scope)
		if (filters.packageId)
			nextUrl.searchParams.set('package', filters.packageId)
		else nextUrl.searchParams.delete('package')
		return `${nextUrl.pathname}${nextUrl.search}`
	}

	function syncEditorState(selection: ListDetailSelection) {
		deleteSecretCheck.reset()
		showSecretValue = false
		if (selection.isCreating) {
			editorState = createEditorStateFromNewSecretQuery(
				packageOptions,
				getCurrentHref(),
			)
			return
		}
		if (selectedSecret) {
			editorState = createEditorStateFromSecret(selectedSecret)
			return
		}
		editorState = createEmptyEditorState(packageOptions)
	}

	function applyPayload(
		payload: AccountSecretsLoaderData,
		selection: ListDetailSelection,
		nextMessage: string | null,
	) {
		packageOptions = payload.packageOptions
		packagesById = new Map(
			payload.packages.map((pkg) => [
				pkg.id,
				{ kodyId: pkg.kodyId, name: pkg.name },
			]),
		)
		secrets = payload.secrets
		selectedSecret = payload.selectedSecret
		approval = payload.approval
			? {
					...payload.approval,
					names:
						payload.approval.names.length > 0
							? payload.approval.names
							: [payload.approval.name],
				}
			: null
		syncEditorState(selection)
		message =
			nextMessage ??
			payload.approvalError ??
			(selection.selectedId && !payload.selectedSecret && !payload.approval
				? 'Secret not found.'
				: null)
		status = 'ready'
		submittingApprovalAction = null
		saveState = 'idle'
	}

	function formatAllowedPackageLabel(packageId: string) {
		const meta = packagesById.get(packageId)
		return meta
			? `${meta.kodyId} (${packageId})`
			: `Unknown package (${packageId})`
	}

	async function loadAccountSecrets() {
		const href = getCurrentHref()
		const selection = secretsRoute.getSelection(href)
		const dataKey = getDataRefreshKey(href)
		const requestId = ++loadRequestId
		loadingDataKey = dataKey
		try {
			const requestUrl = buildSecretsApiRequestUrl(href)

			const response = await fetch(
				`${requestUrl.pathname}${requestUrl.search}`,
				{
					headers: { Accept: 'application/json' },
					credentials: 'include',
				},
			)
			if (
				requestId !== loadRequestId ||
				getDataRefreshKey(getCurrentHref()) !== dataKey
			)
				return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}

			const payload = await readJson<AccountSecretsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load your secrets.')
			}

			lastLoadedDataKey = dataKey
			lastFailedDataKey = null
			if (retryTimeout) {
				clearTimeout(retryTimeout)
				retryTimeout = null
			}
			applyPayload(payload, selection, null)
			handle.update()
		} catch (error) {
			if (
				requestId !== loadRequestId ||
				getDataRefreshKey(getCurrentHref()) !== dataKey
			)
				return
			lastFailedDataKey = dataKey
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load your secrets.'
			handle.update()
			if (typeof window !== 'undefined') {
				if (retryTimeout) {
					clearTimeout(retryTimeout)
					retryTimeout = null
				}
				retryTimeout = window.setTimeout(() => {
					retryTimeout = null
					if (lastFailedDataKey !== dataKey) return
					if (getDataRefreshKey(getCurrentHref()) !== dataKey) return
					lastFailedDataKey = null
					handle.update()
				}, 3000)
			}
		} finally {
			if (requestId === loadRequestId && loadingDataKey === dataKey) {
				loadingDataKey = null
			}
		}
	}

	async function submitApproval(action: ApprovalAction) {
		if (!approval || submittingApprovalAction != null) return
		submittingApprovalAction = action
		message = null
		handle.update()

		try {
			const currentUrl = new URL(getCurrentHref(), 'http://localhost')
			const selection = secretsRoute.getSelection(currentUrl.toString())
			const requestUrl = new URL(accountSecretsApiPath, currentUrl)
			requestUrl.search = currentUrl.search
			if (selection.selectedId) {
				requestUrl.searchParams.set('selected', selection.selectedId)
			}
			const payload = await submitApprovalRequest<
				AccountSecretsLoaderData & { error?: string; ok?: boolean }
			>(action, `${requestUrl.pathname}${requestUrl.search}`)
			if (!payload) return

			const isBulkPackageApproval =
				Boolean(approval.requestedPackageId) && approval.names.length > 1
			applyPayload(
				payload,
				selection,
				action === 'approve'
					? approval.requestedPackageId
						? isBulkPackageApproval
							? `Approved package access for ${approval.names.length} secrets.`
							: 'Approved requested package.'
						: 'Approved requested host.'
					: approval.requestedPackageId
						? isBulkPackageApproval
							? 'Rejected bulk package approval request.'
							: 'Rejected package approval request.'
						: 'Rejected host approval request.',
			)
			handle.update()

			if (typeof window !== 'undefined' && window.location.search) {
				const nextHref = selectedSecret
					? buildHrefWithUpdatedFilters(
							{},
							{
								pathname: buildAccountSecretPath({
									name: selectedSecret.name,
									scope: selectedSecret.scope,
									packageId: selectedSecret.packageId,
								}),
							},
						)
					: buildHrefWithUpdatedFilters({}, { pathname: secretsBasePath })
				const nextUrl = new URL(nextHref, window.location.href)
				nextUrl.searchParams.delete('allowed-host')
				nextUrl.searchParams.delete('capability')
				nextUrl.searchParams.delete('package_id')
				nextUrl.searchParams.delete('package')
				nextUrl.searchParams.delete('names')
				nextUrl.searchParams.delete('name')
				// `navigate` is async (preload-then-commit); the commit render
				// consumes its preloaded data and updates `lastLoadedDataKey`.
				// Pre-setting it to the destination here would make interim
				// renders (current URL unchanged) look like a location change
				// and fire a spurious refetch for the pre-approval URL.
				navigate(`${nextUrl.pathname}${nextUrl.search}`)
			}
		} catch (error) {
			submittingApprovalAction = null
			message =
				error instanceof Error ? error.message : 'Unable to process approval.'
			handle.update()
		}
	}

	async function saveSecretChanges(event: SubmitEvent) {
		event.preventDefault()
		if (saveState !== 'idle') return

		const form = event.currentTarget as HTMLFormElement
		const submittedEditorState = editorState

		saveState = 'saving'
		message = null
		handle.update()

		try {
			const allowedHosts = normalizeAllowedHosts(
				collectRepeatedTextRows(form, 'allowed-hosts'),
			)
			const allowedPackages =
				submittedEditorState.scope === 'user'
					? [...submittedEditorState.allowedPackages].sort((left, right) =>
							left.localeCompare(right),
						)
					: []
			const response = await fetch(accountSecretsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'save',
					currentId: submittedEditorState.currentId,
					name: submittedEditorState.name,
					scope: submittedEditorState.scope,
					packageId:
						submittedEditorState.scope === 'package'
							? submittedEditorState.packageId
							: null,
					description: submittedEditorState.description,
					expiresAt: submittedEditorState.expiresAt || null,
					value: submittedEditorState.value,
					allowedHosts,
					allowedPackages,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}

			const payload = await readJson<
				AccountSecretsLoaderData & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to save secret.')
			}

			const wasCreating = !submittedEditorState.currentId
			const nextSelection: ListDetailSelection = {
				selectedId: payload.selectedSecret?.id ?? null,
				isCreating: false,
			}
			applyPayload(
				payload,
				nextSelection,
				submittedEditorState.currentId ? 'Saved secret.' : 'Created secret.',
			)
			handle.update()

			if (payload.selectedSecret) {
				navigate(
					buildSecretHref(
						payload.selectedSecret,
						wasCreating ? '' : getCurrentSearch(),
					),
				)
			}
		} catch (error) {
			saveState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to save secret.'
			handle.update()
		}
	}

	async function deleteSelectedSecret() {
		if (!editorState.currentId || saveState !== 'idle') return

		saveState = 'deleting'
		message = null
		handle.update()

		try {
			const response = await fetch(accountSecretsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'delete',
					currentId: editorState.currentId,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}

			const payload = await readJson<
				AccountSecretsLoaderData & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to delete secret.')
			}

			applyPayload(
				payload,
				{ selectedId: null, isCreating: false },
				'Deleted secret.',
			)
			deleteSecretCheck.reset()
			handle.update()
			navigate(buildBaseSecretsHref(getCurrentSearch()))
		} catch (error) {
			saveState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to delete secret.'
			handle.update()
		}
	}

	function updateAllowedHost(index: number, value: string) {
		editorState = {
			...editorState,
			allowedHosts: editorState.allowedHosts.map((host, hostIndex) =>
				hostIndex === index ? value : host,
			),
		}
		handle.update()
	}

	function addAllowedHost() {
		editorState = {
			...editorState,
			allowedHosts: [...editorState.allowedHosts, ''],
		}
		handle.update()
	}

	function removeAllowedHost(index: number) {
		const nextHosts = editorState.allowedHosts.filter(
			(_host, hostIndex) => hostIndex !== index,
		)
		editorState = {
			...editorState,
			allowedHosts: nextHosts.length > 0 ? nextHosts : [''],
		}
		handle.update()
	}

	function addAllowedPackage(packageId: string) {
		if (editorState.allowedPackages.includes(packageId)) return
		editorState = {
			...editorState,
			allowedPackages: [...editorState.allowedPackages, packageId],
		}
		handle.update()
	}

	function removeAllowedPackage(packageId: string) {
		editorState = {
			...editorState,
			allowedPackages: editorState.allowedPackages.filter(
				(candidate) => candidate !== packageId,
			),
		}
		handle.update()
	}

	function applyRouteLoaderData(href: string) {
		if (!secretsRoute.isRoutePath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'accountSecrets', href)
		if (!routeData) return false
		const selection = secretsRoute.getSelection(href)
		applyPayload(routeData, selection, routeData.approvalError)
		lastLoadedDataKey = getDataRefreshKey(href)
		lastFailedDataKey = null
		return true
	}

	return () => {
		const currentHref = getCurrentHref()
		const currentDataKey = getDataRefreshKey(currentHref)
		// Consume route-loader data before deriving list state below; deriving
		// first would render this pass from the stale pre-navigation `secrets`
		// (an empty list on SPA navigation) with no follow-up refetch queued.
		const appliedRouteData = applyRouteLoaderData(currentHref)
		// A same-path refresh whose loader failed leaves no preload and no
		// data-key change; the stale marker forces the fallback refetch.
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const isRefreshingForLocationChange =
			status !== 'loading' &&
			currentDataKey !== lastLoadedDataKey &&
			currentDataKey !== lastFailedDataKey
		const isLoadingCurrentLocation = loadingDataKey === currentDataKey
		if (
			!appliedRouteData &&
			(status === 'loading' ||
				isRefreshingForLocationChange ||
				needsStaleRefresh) &&
			!isLoadingCurrentLocation &&
			typeof document !== 'undefined'
		) {
			handle.queueTask(loadAccountSecrets)
		}

		const selection = secretsRoute.getSelection(currentHref)
		const filters = readFilterState(currentHref, packageOptions)
		const filteredSecrets = filterSecrets(secrets, filters, packagesById)
		const packageSelectOptions = packageOptions.map((packageOption) => {
			const metadata = packagesById.get(packageOption.id)
			return {
				id: packageOption.id,
				label: metadata?.kodyId ?? packageOption.title,
				description: packageOption.id,
			}
		})
		const availableAllowedPackageOptions = packageSelectOptions.filter(
			(option) => !editorState.allowedPackages.includes(option.id),
		)
		const filterPackageOptions = [
			{
				id: '',
				label: 'All packages',
				description: 'Show secrets across every package',
			},
			...packageSelectOptions,
		]

		const activeSecretId = selection.selectedId ?? selectedSecret?.id ?? null
		const isMutating = saveState !== 'idle' || submittingApprovalAction != null
		const canCreatePackageSecrets = packageOptions.length > 0
		const showEditor = selection.isCreating || selectedSecret != null
		const secretValueAutofocusKey = getNewSecretValueAutofocusKey(currentHref)
		const alreadyAddedNotice = getAlreadyAddedNotice({
			href: currentHref,
			selectedSecret,
			approval,
			formatPackageId: formatAllowedPackageLabel,
		})
		const approvalCard =
			approval &&
			!isRefreshingForLocationChange &&
			!alreadyAddedNotice?.hostAlreadyAdded &&
			!alreadyAddedNotice?.packageAlreadyAdded
				? approval
				: null
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Secrets"
					description="Passwords and tokens Kody can use for you."
					currentHref={currentHref}
					actions={
						<button
							type="button"
							disabled={isMutating}
							mix={[
								on('click', () => {
									if (isMutating) return
									navigate(buildNewSecretHref(getCurrentSearch()))
								}),
								css(primaryButtonCss),
							]}
						>
							New secret
						</button>
					}
				/>

				{approvalCard
					? renderSecretApprovalCard({
							approvalCard,
							packagesById,
							disabled: isMutating || isRefreshingForLocationChange,
							onSubmit: (action) => void submitApproval(action),
						})
					: null}
				{alreadyAddedNotice
					? renderAlreadyAddedNotice(alreadyAddedNotice.items)
					: null}

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading secrets…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={status === 'error' ? 'error' : 'info'}
					>
						{message}
					</AccountManagementMessage>
				) : null}

				<RecordTable
					mode="expand"
					ariaLabel="Saved secrets"
					selectedId={activeSecretId}
					countLabel={
						status === 'ready'
							? `${filteredSecrets.length} of ${secrets.length} shown`
							: undefined
					}
					emptyLabel={
						status !== 'ready'
							? 'Loading secrets…'
							: secrets.length === 0
								? 'No secrets yet. Create one to get started.'
								: 'No secrets match the current filters.'
					}
					toolbar={
						<>
							<RecordTableSearch
								label="Search secrets"
								placeholder="Search secrets"
								value={filters.search}
								onInput={(value) => {
									replaceLocation(
										buildHrefWithUpdatedFilters({ search: value }),
									)
								}}
							/>
							<RecordTableSelect
								label="Filter secrets by scope"
								value={filters.scope}
								onChange={(value) => {
									const nextScope = value as SecretFilterScope
									replaceLocation(
										buildHrefWithUpdatedFilters({
											scope: nextScope,
											packageId: nextScope === 'user' ? '' : filters.packageId,
										}),
									)
								}}
							>
								<option value="all">All scopes</option>
								<option value="user">User</option>
								<option value="package">Package</option>
							</RecordTableSelect>
							{packageOptions.length > 0 ? (
								<span mix={css({ flex: '1 1 14rem', minWidth: '10rem' })}>
									<Combobox
										key={`secret-package-filter:${filters.packageId}`}
										id="secret-package-filter"
										label="Package filter"
										placeholder="Filter by package"
										value={filters.scope === 'user' ? '' : filters.packageId}
										disabled={filters.scope === 'user'}
										options={filterPackageOptions}
										onChange={(packageId) => {
											replaceLocation(
												buildHrefWithUpdatedFilters({
													packageId,
												}),
											)
										}}
									/>
								</span>
							) : null}
						</>
					}
					columns={[
						{ key: 'name', label: 'Secret', primary: true },
						{ key: 'scope', label: 'Scope' },
						{ key: 'package', label: 'Package', drop: 2 },
						{ key: 'description', label: 'Description', drop: 1 },
						{ key: 'ttl', label: 'Expires' },
					]}
					createRow={
						selection.isCreating
							? {
									href: isMutating
										? undefined
										: buildNewSecretHref(getCurrentSearch()),
									label: 'New secret',
								}
							: undefined
					}
					rows={filteredSecrets.map((secret) => ({
						id: secret.id,
						// A save or delete is in flight; the expanded editor owns
						// the selection until it settles.
						href: isMutating
							? undefined
							: buildSecretHref(secret, getCurrentSearch()),
						cells: {
							name: <span mix={clampedCellCss}>{secret.name}</span>,
							scope: getScopeLabel(secret.scope),
							package: (
								<span mix={clampedCellCss}>{secret.packageTitle || '—'}</span>
							),
							description: (
								<span mix={clampedCellCss}>{secret.description || '—'}</span>
							),
							ttl: (
								<span mix={css(recordStampCss)}>
									{formatRelativeTtl(secret.ttlMs)}
								</span>
							),
						},
					}))}
					record={
						showEditor
							? renderSecretEditor({
									isCreating: selection.isCreating,
									selectedSecret,
									editorState,
									setEditorState: (next) => {
										editorState = next
										handle.update()
									},
									packageOptions,
									packageSelectOptions,
									availableAllowedPackageOptions,
									packagesById,
									canCreatePackageSecrets,
									isMutating,
									saveState,
									showSecretValue,
									onToggleShowSecretValue: () => {
										showSecretValue = !showSecretValue
										handle.update()
									},
									secretValueAutofocusKey,
									deleteSecretCheck,
									onSave: saveSecretChanges,
									onDelete: () => void deleteSelectedSecret(),
									updateAllowedHost,
									addAllowedHost,
									removeAllowedHost,
									addAllowedPackage,
									removeAllowedPackage,
								})
							: null
					}
				/>
			</AccountManagementShell>
		)
	}
}

const primaryButtonCss = getPillButtonCss({ size: 'sm' })
