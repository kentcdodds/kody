import { type Handle } from 'remix/component'
import {
	buildAccountSecretPath,
	parseAccountSecretId,
	parseAccountSecretPath,
} from '@kody-internal/shared/account-secret-route.ts'
import { navigate, routerEvents } from '#client/client-router.tsx'
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
import { TypeaheadCombobox } from '#client/typeahead-combobox.tsx'
import {
	colors,
	mq,
	radius,
	shadows,
	spacing,
	transitions,
	typography,
} from '#client/styles/tokens.ts'
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
import { SecretEditorFields } from './secret-editor-fields.tsx'
import {
	normalizeAllowedCapabilities,
	normalizeAllowedHosts,
} from './secret-normalization.ts'

type SecretScope = 'app' | 'user'

type PackageAppOption = {
	id: string
	title: string
	updatedAt: string
}

type SecretListItem = {
	id: string
	name: string
	scope: SecretScope
	description: string
	appId: string | null
	appTitle: string | null
	allowedHosts: Array<string>
	allowedCapabilities: Array<string>
	allowedPackages: Array<string>
	createdAt: string
	updatedAt: string
	ttlMs: number | null
}

type SecretDetail = SecretListItem & {
	value: string
}

type AccountSecretsPayload = {
	ok: true
	email: string
	apps: Array<PackageAppOption>
	packages: Array<{
		id: string
		kodyId: string
		name: string
	}>
	secrets: Array<SecretListItem>
	selectedSecret: SecretDetail | null
	approval: ApprovalView | null
}

type EditorState = {
	currentId: string | null
	name: string
	scope: SecretScope
	appId: string
	description: string
	value: string
	allowedHosts: Array<string>
	allowedCapabilities: Array<string>
	allowedPackages: Array<string>
}

type SelectionState = {
	selectedSecretId: string | null
	isCreating: boolean
}

type SecretFilterScope = 'all' | 'user' | 'app'

type SecretFilterState = {
	search: string
	scope: SecretFilterScope
	appId: string
}

const secretsBasePath = '/account/secrets'

function formatRelativeTtl(ttlMs: number | null) {
	if (ttlMs == null) return 'No expiry'
	const totalMinutes = Math.max(1, Math.round(ttlMs / 60_000))
	if (totalMinutes < 60) return `Expires in ${totalMinutes} min`
	const totalHours = Math.round(totalMinutes / 60)
	if (totalHours < 48) return `Expires in ${totalHours} hr`
	const totalDays = Math.round(totalHours / 24)
	return `Expires in ${totalDays} day${totalDays === 1 ? '' : 's'}`
}

function formatTimestamp(value: string) {
	return new Date(value).toLocaleString()
}

function createEmptyEditorState(apps: Array<PackageAppOption>): EditorState {
	return {
		currentId: null,
		name: '',
		scope: 'user',
		appId: apps[0]?.id ?? '',
		description: '',
		value: '',
		allowedHosts: [''],
		allowedCapabilities: [''],
		allowedPackages: [''],
	}
}

function coerceStringRows(list: Array<unknown>): Array<string> {
	return list.filter((item): item is string => typeof item === 'string')
}

function collectRepeatedTextRows(
	form: HTMLFormElement,
	listName: 'allowed-hosts' | 'allowed-capabilities',
): Array<string> {
	const root = form.querySelector(`[data-repeat-list="${listName}"]`)
	if (!root) return []
	const out: Array<string> = []
	for (const row of root.children) {
		if (!(row instanceof HTMLElement)) continue
		const input = row.querySelector('input[type="text"]')
		if (input instanceof HTMLInputElement) out.push(input.value)
	}
	return out
}

function createEditorStateFromSecret(secret: SecretDetail): EditorState {
	const allowedHosts = coerceStringRows(secret.allowedHosts)
	const allowedCapabilities = coerceStringRows(secret.allowedCapabilities)
	const allowedPackages = coerceStringRows(secret.allowedPackages)
	return {
		currentId: secret.id,
		name: secret.name,
		scope: secret.scope,
		appId: secret.appId ?? '',
		description: secret.description,
		value: secret.value,
		allowedHosts: allowedHosts.length > 0 ? allowedHosts : [''],
		allowedCapabilities:
			allowedCapabilities.length > 0 ? allowedCapabilities : [''],
		allowedPackages: allowedPackages.length > 0 ? allowedPackages : [''],
	}
}

function getSelectionState(href: string): SelectionState {
	const url = new URL(href, 'http://localhost')
	if (url.pathname === `${secretsBasePath}/new`) {
		return {
			selectedSecretId: null,
			isCreating: true,
		}
	}
	if (url.pathname === `${secretsBasePath}/approve`) {
		return {
			selectedSecretId: null,
			isCreating: false,
		}
	}
	const parsedPath = parseAccountSecretPath(url.pathname)
	if (parsedPath) {
		return {
			selectedSecretId: parsedPath.id,
			isCreating: false,
		}
	}
	if (url.pathname.startsWith(`${secretsBasePath}/`)) {
		const legacySecretId = url.pathname.slice(`${secretsBasePath}/`.length)
		const parsedLegacyId = parseAccountSecretId(legacySecretId)
		return {
			selectedSecretId: parsedLegacyId
				? legacySecretId
				: url.pathname.slice(`${secretsBasePath}/`.length),
			isCreating: false,
		}
	}
	return {
		selectedSecretId: null,
		isCreating: false,
	}
}

function getCurrentHref() {
	return typeof window === 'undefined' ? secretsBasePath : window.location.href
}

function getCurrentSearch() {
	return typeof window === 'undefined' ? '' : window.location.search
}

function buildSecretsHref(pathname: string, search = getCurrentSearch()) {
	return `${pathname}${search}`
}

function readCapabilityPrefill(href: string) {
	const url = new URL(href, 'http://localhost')
	const value = url.searchParams.get('capability')
	return value?.trim() ? value.trim() : null
}

function readRequestedHost(href: string) {
	const url = new URL(href, 'http://localhost')
	const value = url.searchParams.get('allowed-host')
	return value?.trim() ? value.trim() : null
}

function normalizeSingleAllowedHost(host: string | null) {
	if (!host) return null
	return normalizeAllowedHosts([host])[0] ?? null
}

function normalizeSingleAllowedCapability(capability: string | null) {
	if (!capability) return null
	return normalizeAllowedCapabilities([capability])[0] ?? null
}

function getAlreadyAddedNotice(input: {
	href: string
	selectedSecret: SecretDetail | null
	approval: ApprovalView | null
}) {
	const requestedHost = normalizeSingleAllowedHost(
		readRequestedHost(input.href),
	)
	const requestedCapability = normalizeSingleAllowedCapability(
		readCapabilityPrefill(input.href),
	)
	const requestedPackageId =
		new URL(input.href, 'http://localhost').searchParams
			.get('package_id')
			?.trim() ?? null
	const allowedHosts = input.selectedSecret
		? normalizeAllowedHosts(coerceStringRows(input.selectedSecret.allowedHosts))
		: input.approval
			? normalizeAllowedHosts(input.approval.currentAllowedHosts)
			: []
	const allowedCapabilities = input.selectedSecret
		? normalizeAllowedCapabilities(
				coerceStringRows(input.selectedSecret.allowedCapabilities),
			)
		: []
	const allowedPackageIds = input.selectedSecret
		? Array.from(
				new Set(
					input.selectedSecret.allowedPackages.filter(
						(value) => value.length > 0,
					),
				),
			).sort((left, right) => left.localeCompare(right))
		: input.approval
			? Array.from(
					new Set(
						input.approval.currentAllowedPackages.filter(
							(value) => value.length > 0,
						),
					),
				).sort((left, right) => left.localeCompare(right))
			: []
	const items: Array<string> = []
	const hostAlreadyAdded =
		requestedHost != null && allowedHosts.includes(requestedHost)
	if (hostAlreadyAdded) {
		items.push(`Host ${requestedHost} is already in allowed hosts.`)
	}
	if (
		requestedCapability != null &&
		allowedCapabilities.includes(requestedCapability)
	) {
		items.push(
			`Capability ${requestedCapability} is already in allowed capabilities.`,
		)
	}
	const packageAlreadyAdded =
		requestedPackageId != null && allowedPackageIds.includes(requestedPackageId)
	if (packageAlreadyAdded) {
		items.push(`Package ${requestedPackageId} is already in allowed packages.`)
	}
	if (items.length === 0) return null
	return {
		items,
		hostAlreadyAdded,
		packageAlreadyAdded,
	}
}

function applyCapabilityPrefill(state: EditorState, capability: string | null) {
	if (!capability) return state
	if (state.allowedCapabilities.some((entry) => entry.trim() === capability)) {
		return state
	}
	const nextAllowedCapabilities =
		state.allowedCapabilities.length === 1 &&
		state.allowedCapabilities[0]?.trim() === ''
			? [capability]
			: [...state.allowedCapabilities, capability]
	return {
		...state,
		allowedCapabilities: nextAllowedCapabilities,
	}
}

function buildSecretHref(secret: {
	name: string
	scope: SecretScope
	appId: string | null
}) {
	return buildSecretsHref(
		buildAccountSecretPath({
			name: secret.name,
			scope: secret.scope,
			appId: secret.appId,
		}),
	)
}

function buildNewSecretHref() {
	return buildSecretsHref(`${secretsBasePath}/new`)
}

function buildBaseSecretsHref() {
	return buildSecretsHref(secretsBasePath)
}

function replaceSecretsLocation(to: string) {
	if (typeof window === 'undefined') return
	const destination = new URL(to, window.location.href)
	const nextPath = `${destination.pathname}${destination.search}${destination.hash}`
	const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`
	if (nextPath === currentPath) return
	window.history.replaceState({}, '', nextPath)
	routerEvents.dispatchEvent(new Event('navigate'))
}

function getDataRefreshKey(href: string) {
	const url = new URL(href, 'http://localhost')
	const request = url.searchParams.get('request') ?? ''
	const requestedHost = url.searchParams.get('allowed-host') ?? ''
	const requestedCapability = url.searchParams.get('capability') ?? ''
	const requestedPackageId = url.searchParams.get('package_id') ?? ''
	return `${url.pathname}?request=${request}&allowed-host=${requestedHost}&capability=${requestedCapability}&package_id=${requestedPackageId}`
}

function readFilterState(
	href: string,
	apps: Array<PackageAppOption>,
): SecretFilterState {
	const url = new URL(href, 'http://localhost')
	const search = url.searchParams.get('q')?.trim() ?? ''
	const rawScope = url.searchParams.get('scope')
	const scope =
		rawScope === 'user' || rawScope === 'app' ? rawScope : ('all' as const)
	const rawAppId = url.searchParams.get('app')?.trim() ?? ''
	const appId =
		scope === 'user'
			? ''
			: apps.some((app) => app.id === rawAppId)
				? rawAppId
				: ''
	return {
		search,
		scope,
		appId,
	}
}

function filterSecrets(
	secrets: Array<SecretListItem>,
	filters: SecretFilterState,
) {
	const search = filters.search.trim().toLowerCase()
	return secrets.filter((secret) => {
		if (filters.scope !== 'all' && secret.scope !== filters.scope) return false
		if (
			filters.scope !== 'user' &&
			filters.appId &&
			secret.appId !== filters.appId
		)
			return false
		if (!search) return true

		const haystack = [
			secret.name,
			secret.description,
			secret.appTitle ?? '',
			secret.scope,
			...secret.allowedHosts,
			...secret.allowedCapabilities,
			...secret.allowedPackages,
		]
			.join(' ')
			.toLowerCase()
		return haystack.includes(search)
	})
}

function buildAppOptionDescription(updatedAt: string) {
	return `Updated ${new Date(updatedAt).toLocaleDateString()}`
}

export function AccountSecretsRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let email = ''
	let apps: Array<PackageAppOption> = []
	let packagesById = new Map<string, { kodyId: string; name: string }>()
	let secrets: Array<SecretListItem> = []
	let selectedSecret: SecretDetail | null = null
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
	const filterAppCombobox = TypeaheadCombobox(handle)
	const editorAppCombobox = TypeaheadCombobox(handle)

	function buildHrefWithUpdatedFilters(
		nextFilters: Partial<SecretFilterState>,
		options?: { pathname?: string },
	) {
		const currentUrl = new URL(getCurrentHref(), 'http://localhost')
		const filters = {
			...readFilterState(currentUrl.toString(), apps),
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
		if (filters.appId) nextUrl.searchParams.set('app', filters.appId)
		else nextUrl.searchParams.delete('app')
		return `${nextUrl.pathname}${nextUrl.search}`
	}

	function syncEditorState(selection: SelectionState) {
		deleteSecretCheck.reset()
		showSecretValue = false
		const capabilityPrefill = readCapabilityPrefill(getCurrentHref())
		if (selection.isCreating) {
			editorState = applyCapabilityPrefill(
				createEmptyEditorState(apps),
				capabilityPrefill,
			)
			return
		}
		if (selectedSecret) {
			editorState = applyCapabilityPrefill(
				createEditorStateFromSecret(selectedSecret),
				capabilityPrefill,
			)
			return
		}
		editorState = applyCapabilityPrefill(
			createEmptyEditorState(apps),
			capabilityPrefill,
		)
	}

	function applyPayload(
		payload: AccountSecretsPayload,
		selection: SelectionState,
		nextMessage: string | null,
	) {
		email = payload.email
		apps = payload.apps
		packagesById = new Map(
			payload.packages.map((pkg) => [
				pkg.id,
				{ kodyId: pkg.kodyId, name: pkg.name },
			]),
		)
		secrets = payload.secrets
		selectedSecret = payload.selectedSecret
		approval = payload.approval
		syncEditorState(selection)
		message =
			nextMessage ??
			(selection.selectedSecretId &&
			!payload.selectedSecret &&
			!payload.approval
				? 'Secret not found.'
				: null)
		status = 'ready'
		submittingApprovalAction = null
		saveState = 'idle'
	}

	function formatAllowedPackageLabel(packageId: string) {
		const meta = packagesById.get(packageId)
		return meta ? `${meta.name} (${packageId})` : packageId
	}

	async function loadAccountSecrets() {
		const href = getCurrentHref()
		const selection = getSelectionState(href)
		const dataKey = getDataRefreshKey(href)
		const requestId = ++loadRequestId
		loadingDataKey = dataKey
		try {
			const requestUrl = new URL(accountSecretsApiPath, href)
			requestUrl.search = new URL(href).search
			if (selection.selectedSecretId) {
				requestUrl.searchParams.set('selected', selection.selectedSecretId)
			} else {
				requestUrl.searchParams.delete('selected')
			}

			const response = await fetch(requestUrl.toString(), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (
				requestId !== loadRequestId ||
				getDataRefreshKey(getCurrentHref()) !== dataKey
			)
				return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}

			const payload = await readJson<AccountSecretsPayload>(response)
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
			const payload = await submitApprovalRequest<
				AccountSecretsPayload & { error?: string; ok?: boolean }
			>(action, approval.token)
			if (!payload) return

			const selection = getSelectionState(getCurrentHref())
			applyPayload(
				payload,
				selection,
				action === 'approve'
					? approval.requestedPackageId
						? 'Approved requested package.'
						: 'Approved requested host.'
					: approval.requestedPackageId
						? 'Rejected package approval request.'
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
									appId: selectedSecret.appId,
								}),
							},
						)
					: buildHrefWithUpdatedFilters({}, { pathname: secretsBasePath })
				const nextUrl = new URL(nextHref, window.location.href)
				nextUrl.searchParams.delete('request')
				nextUrl.searchParams.delete('allowed-host')
				nextUrl.searchParams.delete('capability')
				nextUrl.searchParams.delete('package_id')
				nextUrl.searchParams.delete('package')
				navigate(`${nextUrl.pathname}${nextUrl.search}`)
				lastLoadedDataKey = getDataRefreshKey(nextUrl.toString())
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

		saveState = 'saving'
		message = null
		handle.update()

		try {
			const allowedHosts = normalizeAllowedHosts(
				collectRepeatedTextRows(form, 'allowed-hosts'),
			)
			const allowedCapabilities = normalizeAllowedCapabilities(
				collectRepeatedTextRows(form, 'allowed-capabilities'),
			)
			const allowedPackages = Array.from(
				new Set(
					editorState.allowedPackages
						.map((value) => value.trim())
						.filter((value) => value.length > 0),
				),
			).sort((left, right) => left.localeCompare(right))
			const response = await fetch(accountSecretsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'save',
					currentId: editorState.currentId,
					name: editorState.name,
					scope: editorState.scope,
					appId: editorState.scope === 'app' ? editorState.appId : null,
					description: editorState.description,
					value: editorState.value,
					allowedHosts,
					allowedCapabilities,
					allowedPackages,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}

			const payload = await readJson<
				AccountSecretsPayload & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to save secret.')
			}

			const nextSelection: SelectionState = {
				selectedSecretId: payload.selectedSecret?.id ?? null,
				isCreating: false,
			}
			applyPayload(
				payload,
				nextSelection,
				editorState.currentId ? 'Saved secret.' : 'Created secret.',
			)
			handle.update()

			if (payload.selectedSecret) {
				navigate(buildSecretHref(payload.selectedSecret))
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
				AccountSecretsPayload & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to delete secret.')
			}

			applyPayload(
				payload,
				{ selectedSecretId: null, isCreating: false },
				'Deleted secret.',
			)
			deleteSecretCheck.reset()
			handle.update()
			navigate(buildBaseSecretsHref())
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

	function updateAllowedCapability(index: number, value: string) {
		editorState = {
			...editorState,
			allowedCapabilities: editorState.allowedCapabilities.map(
				(capabilityName, capabilityIndex) =>
					capabilityIndex === index ? value : capabilityName,
			),
		}
		handle.update()
	}

	function addAllowedCapability() {
		editorState = {
			...editorState,
			allowedCapabilities: [...editorState.allowedCapabilities, ''],
		}
		handle.update()
	}

	function removeAllowedCapability(index: number) {
		const nextCapabilities = editorState.allowedCapabilities.filter(
			(_capabilityName, capabilityIndex) => capabilityIndex !== index,
		)
		editorState = {
			...editorState,
			allowedCapabilities:
				nextCapabilities.length > 0 ? nextCapabilities : [''],
		}
		handle.update()
	}

	function updateAllowedPackage(index: number, value: string) {
		editorState = {
			...editorState,
			allowedPackages: editorState.allowedPackages.map((pkg, pkgIndex) =>
				pkgIndex === index ? value : pkg,
			),
		}
		handle.update()
	}

	function addAllowedPackage() {
		editorState = {
			...editorState,
			allowedPackages: [...editorState.allowedPackages, ''],
		}
		handle.update()
	}

	function removeAllowedPackage(index: number) {
		const nextPackages = editorState.allowedPackages.filter(
			(_pkg, pkgIndex) => pkgIndex !== index,
		)
		editorState = {
			...editorState,
			allowedPackages: nextPackages.length > 0 ? nextPackages : [''],
		}
		handle.update()
	}

	return () => {
		const currentHref = getCurrentHref()
		const selection = getSelectionState(currentHref)
		const filters = readFilterState(currentHref, apps)
		const filteredSecrets = filterSecrets(secrets, filters)
		const appOptions = apps.map((app) => ({
			id: app.id,
			label: app.title,
			description: buildAppOptionDescription(app.updatedAt),
		}))
		const filterAppOptions = [
			{
				id: '',
				label: 'All apps',
				description: 'Show secrets across every app',
			},
			...appOptions,
		]
		const currentDataKey = getDataRefreshKey(currentHref)
		const isRefreshingForLocationChange =
			status !== 'loading' &&
			currentDataKey !== lastLoadedDataKey &&
			currentDataKey !== lastFailedDataKey
		const isLoadingCurrentLocation = loadingDataKey === currentDataKey
		if (
			(status === 'loading' || isRefreshingForLocationChange) &&
			!isLoadingCurrentLocation
		) {
			handle.queueTask(loadAccountSecrets)
		}

		const activeSecretId =
			selection.selectedSecretId ?? selectedSecret?.id ?? null
		const isMutating = saveState !== 'idle' || submittingApprovalAction != null
		const canCreateAppSecrets = apps.length > 0
		const showEditor = selection.isCreating || selectedSecret != null
		const alreadyAddedNotice = getAlreadyAddedNotice({
			href: currentHref,
			selectedSecret,
			approval,
		})
		const approvalCard =
			approval &&
			!isRefreshingForLocationChange &&
			!alreadyAddedNotice?.hostAlreadyAdded &&
			!alreadyAddedNotice?.packageAlreadyAdded
				? approval
				: null

		return (
			<section
				css={{
					maxWidth: '96rem',
					margin: '0 auto',
					display: 'grid',
					gap: spacing.xl,
				}}
			>
				<header
					css={{
						display: 'flex',
						justifyContent: 'space-between',
						alignItems: 'flex-start',
						gap: spacing.md,
						flexWrap: 'wrap',
					}}
				>
					<div css={{ display: 'grid', gap: spacing.xs }}>
						<h1
							css={{
								fontSize: typography.fontSize.xl,
								fontWeight: typography.fontWeight.semibold,
								color: colors.text,
								margin: 0,
							}}
						>
							{email ? `${email} secrets` : 'Secrets'}
						</h1>
						<p css={{ color: colors.textMuted, margin: 0 }}>
							Create, update, and delete the secrets available to your account
							and package apps.
						</p>
					</div>
					<button
						type="button"
						on={{ click: () => navigate(buildNewSecretHref()) }}
						css={primaryButtonCss}
					>
						New secret
					</button>
				</header>

				{approvalCard ? (
					<section
						css={{
							display: 'grid',
							gap: spacing.md,
							padding: spacing.lg,
							borderRadius: radius.lg,
							border: `1px solid ${colors.primary}`,
							backgroundColor: colors.primarySoftest,
						}}
					>
						<div css={{ display: 'grid', gap: spacing.xs }}>
							<h2
								css={{
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								}}
							>
								Approve secret access
							</h2>
							{approvalCard.requestedPackageId ? (
								<p css={{ margin: 0, color: colors.textMuted }}>
									Allow package{' '}
									<code>{approvalCard.requestedPackageId}</code>{' '}
									to use secret <code>{approvalCard.name}</code> from the{' '}
									{getScopeLabel(approvalCard.scope)} scope.
								</p>
							) : (
								<p css={{ margin: 0, color: colors.textMuted }}>
									Allow <code>{approvalCard.requestedHost}</code> to receive
									secret <code>{approvalCard.name}</code> from the{' '}
									{getScopeLabel(approvalCard.scope)} scope.
								</p>
							)}
							{approvalCard.requestedCapability ? (
								<p css={{ margin: 0, color: colors.textMuted }}>
									Requested capability:{' '}
									<code>{approvalCard.requestedCapability}</code>
								</p>
							) : null}
							{approvalCard.requestedPackageId ? (
								<p css={{ margin: 0, color: colors.textMuted }}>
									Current allowed packages:{' '}
									{approvalCard.currentAllowedPackages.length > 0
										? approvalCard.currentAllowedPackages
												.map((packageId) =>
													formatAllowedPackageLabel(packageId),
												)
												.join(', ')
										: 'none'}
								</p>
							) : (
								<p css={{ margin: 0, color: colors.textMuted }}>
									Current allowed hosts:{' '}
									{approvalCard.currentAllowedHosts.length > 0
										? approvalCard.currentAllowedHosts.join(', ')
										: 'none'}
								</p>
							)}
						</div>
						<div css={{ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' }}>
							<button
								type="button"
								disabled={isMutating || isRefreshingForLocationChange}
								on={{ click: () => void submitApproval('approve') }}
								css={primaryButtonCss}
							>
								Approve
							</button>
							<button
								type="button"
								disabled={isMutating || isRefreshingForLocationChange}
								on={{ click: () => void submitApproval('reject') }}
								css={secondaryButtonCss}
							>
								Reject
							</button>
						</div>
					</section>
				) : null}
				{alreadyAddedNotice ? (
					<section
						css={{
							display: 'grid',
							gap: spacing.sm,
							padding: spacing.lg,
							borderRadius: radius.lg,
							border: `1px solid ${colors.primary}`,
							backgroundColor: colors.primarySoftest,
						}}
						role="status"
					>
						<div css={{ display: 'grid', gap: spacing.xs }}>
							<h2
								css={{
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								}}
							>
								Already added
							</h2>
							<p css={{ margin: 0, color: colors.textMuted }}>
								This request is already complete for this secret.
							</p>
						</div>
						<ul
							css={{
								margin: 0,
								paddingLeft: spacing.lg,
								color: colors.textMuted,
								display: 'grid',
								gap: spacing.xs,
							}}
						>
							{alreadyAddedNotice.items.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					</section>
				) : null}

				{status === 'loading' ? (
					<p css={{ color: colors.textMuted, margin: 0 }}>Loading secrets…</p>
				) : null}
				{message ? (
					<p
						css={{
							color: status === 'error' ? colors.error : colors.text,
							margin: 0,
						}}
						role="alert"
					>
						{message}
					</p>
				) : null}

				<section
					css={{
						display: 'grid',
						gridTemplateColumns: 'minmax(18rem, 22rem) minmax(0, 1fr)',
						gap: spacing.lg,
						alignItems: 'start',
						[mq.mobile]: {
							gridTemplateColumns: '1fr',
						},
					}}
				>
					<aside
						css={{
							...cardCss,
							alignSelf: 'start',
						}}
					>
						<div css={{ display: 'grid', gap: spacing.xs }}>
							<h2 css={cardTitleCss}>Saved secrets</h2>
							<p css={descriptionCss}>
								Select a secret to edit its metadata, value, and allowed hosts.
							</p>
						</div>
						<div
							css={{
								display: 'grid',
								gap: spacing.sm,
							}}
						>
							<label css={fieldCss}>
								<span css={fieldLabelCss}>Search</span>
								<input
									type="search"
									value={filters.search}
									placeholder="Search secrets"
									aria-label="Search secrets"
									on={{
										input: (event) => {
											replaceSecretsLocation(
												buildHrefWithUpdatedFilters({
													search: event.currentTarget.value,
												}),
											)
										},
									}}
									css={inputCss}
								/>
							</label>
							<label css={fieldCss}>
								<span css={fieldLabelCss}>Scope</span>
								<select
									value={filters.scope}
									aria-label="Filter secrets by scope"
									on={{
										change: (event) => {
											const nextScope = event.currentTarget
												.value as SecretFilterScope
											replaceSecretsLocation(
												buildHrefWithUpdatedFilters({
													scope: nextScope,
													appId: nextScope === 'user' ? '' : filters.appId,
												}),
											)
										},
									}}
									css={inputCss}
								>
									<option value="all">All scopes</option>
									<option value="user">User</option>
									<option value="app">App</option>
								</select>
							</label>
							{apps.length > 0
								? filterAppCombobox({
										id: 'secret-app-filter',
										label: 'App filter',
										placeholder: 'Filter by app',
										value: filters.scope === 'user' ? '' : filters.appId,
										disabled: filters.scope === 'user',
										options: filterAppOptions,
										onChange: (appId) => {
											replaceSecretsLocation(
												buildHrefWithUpdatedFilters({
													appId,
												}),
											)
										},
										inputCss,
										listCss: comboboxListCss,
										optionCss: comboboxOptionCss,
									})
								: null}
						</div>
						{status === 'ready' && secrets.length === 0 ? (
							<p css={{ margin: 0, color: colors.textMuted }}>
								No secrets yet. Create one to get started.
							</p>
						) : status === 'ready' && filteredSecrets.length === 0 ? (
							<p css={{ margin: 0, color: colors.textMuted }}>
								No secrets match the current filters.
							</p>
						) : (
							<div
								css={{
									maxHeight: 'min(65vh, 48rem)',
									overflowY: 'auto',
									paddingRight: spacing.xs,
								}}
							>
								<ul
									css={{
										listStyle: 'none',
										padding: 0,
										margin: 0,
										display: 'grid',
										gap: spacing.sm,
									}}
								>
									{filteredSecrets.map((secret) => {
										const isActive = activeSecretId === secret.id
										return (
											<li key={secret.id}>
												<button
													type="button"
													on={{
														click: () => navigate(buildSecretHref(secret)),
													}}
													css={{
														width: '100%',
														textAlign: 'left',
														display: 'grid',
														gap: spacing.xs,
														padding: spacing.md,
														borderRadius: radius.md,
														border: `1px solid ${
															isActive ? colors.primary : colors.border
														}`,
														backgroundColor: isActive
															? colors.primarySoftest
															: colors.background,
														color: colors.text,
														cursor: 'pointer',
														transition: `background-color ${transitions.normal}, border-color ${transitions.normal}`,
													}}
												>
													<div
														css={{
															display: 'flex',
															justifyContent: 'space-between',
															gap: spacing.sm,
															alignItems: 'baseline',
														}}
													>
														<strong>{secret.name}</strong>
														<span
															css={{
																fontSize: typography.fontSize.xs,
																color: colors.textMuted,
															}}
														>
															{formatRelativeTtl(secret.ttlMs)}
														</span>
													</div>
													<span
														css={{
															fontSize: typography.fontSize.sm,
															color: colors.textMuted,
														}}
													>
														{getScopeLabel(secret.scope)}
														{secret.appTitle ? ` - ${secret.appTitle}` : ''}
													</span>
													{secret.description ? (
														<span
															css={{
																fontSize: typography.fontSize.sm,
																color: colors.textMuted,
															}}
														>
															{secret.description}
														</span>
													) : null}
												</button>
											</li>
										)
									})}
								</ul>
							</div>
						)}
					</aside>

					<div
						css={{
							...cardCss,
							gap: spacing.lg,
						}}
					>
						{showEditor ? (
							<form
								css={{ display: 'grid', gap: spacing.lg }}
								on={{ submit: saveSecretChanges }}
							>
								<div css={{ display: 'grid', gap: spacing.xs }}>
									<h2
										css={{
											margin: 0,
											fontSize: typography.fontSize.lg,
											fontWeight: typography.fontWeight.semibold,
											color: colors.text,
										}}
									>
										{selection.isCreating ? 'New secret' : selectedSecret?.name}
									</h2>
									<p css={{ margin: 0, color: colors.textMuted }}>
										{selection.isCreating
											? 'Create a new user or app secret.'
											: 'Update the secret value and metadata for this entry.'}
									</p>
								</div>

								<div
									css={{
										display: 'grid',
										gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
										gap: spacing.md,
										[mq.mobile]: {
											gridTemplateColumns: '1fr',
										},
									}}
								>
									<label css={fieldCss}>
										<span css={fieldLabelCss}>Name</span>
										<input
											type="text"
											required
											value={editorState.name}
											placeholder="api-token"
											on={{
												input: (event) => {
													editorState = {
														...editorState,
														name: event.currentTarget.value,
													}
													handle.update()
												},
											}}
											css={inputCss}
										/>
									</label>

									<label css={fieldCss}>
										<span css={fieldLabelCss}>Scope</span>
										<select
											value={editorState.scope}
											on={{
												change: (event) => {
													const scope = event.currentTarget.value as SecretScope
													editorState = {
														...editorState,
														scope,
														appId:
															scope === 'app'
																? editorState.appId || apps[0]?.id || ''
																: '',
													}
													handle.update()
												},
											}}
											css={inputCss}
										>
											<option value="user">User</option>
											{canCreateAppSecrets ? (
												<option value="app">App</option>
											) : null}
										</select>
									</label>
								</div>

								{editorState.scope === 'app'
									? editorAppCombobox({
											id: 'secret-editor-app',
											label: 'App',
											placeholder: 'Choose an app',
											value: editorState.appId,
											options: appOptions,
											onChange: (appId) => {
												editorState = {
													...editorState,
													appId,
												}
												handle.update()
											},
											inputCss,
											listCss: comboboxListCss,
											optionCss: comboboxOptionCss,
										})
									: null}

								<SecretEditorFields
									description={editorState.description}
									onDescriptionChange={(description) => {
										editorState = {
											...editorState,
											description,
										}
										handle.update()
									}}
									value={editorState.value}
									onValueChange={(value) => {
										editorState = {
											...editorState,
											value,
										}
										handle.update()
									}}
									showSecretValue={showSecretValue}
									onToggleShowSecretValue={() => {
										showSecretValue = !showSecretValue
										handle.update()
									}}
									allowedHosts={editorState.allowedHosts}
									onUpdateAllowedHost={updateAllowedHost}
									onAddAllowedHost={addAllowedHost}
									onRemoveAllowedHost={removeAllowedHost}
									allowedCapabilities={editorState.allowedCapabilities}
									onUpdateAllowedCapability={updateAllowedCapability}
									onAddAllowedCapability={addAllowedCapability}
									onRemoveAllowedCapability={removeAllowedCapability}
									allowedHostsListName="allowed-hosts"
									allowedCapabilitiesListName="allowed-capabilities"
								/>
								<div css={{ display: 'grid', gap: spacing.sm }}>
									<div css={{ display: 'grid', gap: spacing.xs }}>
										<span css={fieldLabelCss}>Allowed packages</span>
										<p css={{ margin: 0, color: colors.textMuted }}>
											Only listed package ids may read this secret via package
											secret mounts.
										</p>
									</div>
									<div css={{ display: 'grid', gap: spacing.sm }}>
										{editorState.allowedPackages.map((packageId, index) => (
											<div
												key={index}
												css={{
													display: 'grid',
													gridTemplateColumns: 'minmax(0, 1fr) auto',
													gap: spacing.sm,
												}}
											>
												<input
													type="text"
													value={typeof packageId === 'string' ? packageId : ''}
													placeholder="saved package id"
													on={{
														input: (event) => {
															updateAllowedPackage(
																index,
																event.currentTarget.value,
															)
														},
													}}
													css={inputCss}
												/>
												<button
													type="button"
													on={{ click: () => removeAllowedPackage(index) }}
													css={secondaryButtonCss}
												>
													Remove
												</button>
											</div>
										))}
									</div>
									<div>
										<button
											type="button"
											on={{ click: () => addAllowedPackage() }}
											css={secondaryButtonCss}
										>
											Add package
										</button>
									</div>
								</div>

								{selectedSecret ? (
									<div
										css={{
											display: 'grid',
											gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
											gap: spacing.md,
											padding: spacing.md,
											borderRadius: radius.md,
											backgroundColor: colors.background,
											border: `1px solid ${colors.border}`,
											[mq.mobile]: {
												gridTemplateColumns: '1fr',
											},
										}}
									>
										<div css={{ display: 'grid', gap: spacing.xs }}>
											<span css={fieldLabelCss}>Created</span>
											<span css={{ color: colors.textMuted }}>
												{formatTimestamp(selectedSecret.createdAt)}
											</span>
										</div>
										<div css={{ display: 'grid', gap: spacing.xs }}>
											<span css={fieldLabelCss}>Updated</span>
											<span css={{ color: colors.textMuted }}>
												{formatTimestamp(selectedSecret.updatedAt)}
											</span>
										</div>
										<div css={{ display: 'grid', gap: spacing.xs }}>
											<span css={fieldLabelCss}>Expiry</span>
											<span css={{ color: colors.textMuted }}>
												{formatRelativeTtl(selectedSecret.ttlMs)}
											</span>
										</div>
									</div>
								) : null}

								<div
									css={{
										display: 'flex',
										gap: spacing.sm,
										flexWrap: 'wrap',
									}}
								>
									<button
										type="submit"
										disabled={
											isMutating ||
											(editorState.scope === 'app' && !editorState.appId)
										}
										css={primaryButtonCss}
									>
										{saveState === 'saving' ? 'Saving...' : 'Save'}
									</button>
									{editorState.currentId ? (
										<button
											type="button"
											disabled={isMutating}
											{...deleteSecretCheck.getButtonProps({
												on: {
													click: () => void deleteSelectedSecret(),
												},
											})}
											aria-label={
												deleteSecretCheck.doubleCheck
													? `Confirm delete secret "${editorState.name}"`
													: `Delete secret "${editorState.name}"`
											}
											title={
												deleteSecretCheck.doubleCheck
													? `Click again to delete "${editorState.name}"`
													: `Delete secret "${editorState.name}"`
											}
											css={dangerButtonCss}
										>
											{saveState === 'deleting'
												? 'Deleting...'
												: deleteSecretCheck.doubleCheck
													? 'Confirm delete'
													: 'Delete'}
										</button>
									) : null}
								</div>
							</form>
						) : (
							<div css={{ display: 'grid', gap: spacing.sm }}>
								<h2
									css={{
										margin: 0,
										fontSize: typography.fontSize.lg,
										fontWeight: typography.fontWeight.semibold,
										color: colors.text,
									}}
								>
									Select a secret
								</h2>
								<p css={{ margin: 0, color: colors.textMuted }}>
									Pick a secret from the list to edit it, or create a new one.
								</p>
							</div>
						)}
					</div>
				</section>
			</section>
		)
	}
}

const comboboxListCss = {
	position: 'absolute' as const,
	top: '100%',
	left: 0,
	right: 0,
	zIndex: 10,
	marginTop: spacing.xs,
	maxHeight: '18rem',
	overflowY: 'auto' as const,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	boxShadow: shadows.md,
	padding: spacing.xs,
	display: 'grid',
	gap: spacing.xs,
}

const comboboxOptionCss = {
	display: 'grid',
	gap: spacing.xs,
	width: '100%',
	textAlign: 'left' as const,
	padding: spacing.sm,
	borderRadius: radius.md,
	border: 'none',
	backgroundColor: 'transparent',
	color: colors.text,
	cursor: 'pointer',
	'&[data-active="true"]': {
		backgroundColor: colors.primarySoftest,
	},
	'&:hover': {
		backgroundColor: colors.primarySoftest,
	},
}

const primaryButtonCss = getPrimaryButtonCss()
const secondaryButtonCss = getSecondaryButtonCss()
const dangerButtonCss = getDangerButtonCss()
