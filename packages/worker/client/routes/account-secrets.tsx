import { formatTimestamp } from '#client/format-timestamp.ts'
import { readCommaListParams, readTrimmedParam } from '#client/url-params.ts'
import {
	type AccountSecretDetail,
	type AccountSecretListItem,
	type AccountSecretsLoaderData,
} from '#app/loader-data.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import {
	buildAccountSecretPath,
	parseAccountSecretPath,
} from '@kody-internal/shared/account-secret-route.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import {
	createListDetailRoute,
	type ListDetailSelection,
} from '#client/list-detail-route.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
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
import { matchesSearchQuery } from '#client/search-filter.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#client/styles/tokens.ts'
import {
	cardCss,
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
	normalizeAllowedPackages,
} from './secret-normalization.ts'
import {
	AccountManagementLayout,
	AccountManagementList,
	AccountManagementListItemButton,
	AccountManagementMessage,
	AccountManagementSearchField,
	AccountManagementShell,
	AccountManagementSidebar,
	AccountPageHeader,
	MetadataGrid,
} from './account-management-components.tsx'

type SecretScope = AccountSecretListItem['scope']

type PackageOption = AccountSecretsLoaderData['packageOptions'][number]

type EditorState = {
	currentId: string | null
	name: string
	scope: SecretScope
	packageId: string
	description: string
	value: string
	allowedHosts: Array<string>
	allowedCapabilities: Array<string>
	allowedPackages: Array<string>
}

type SecretFilterScope = 'all' | 'user' | 'package'

type SecretFilterState = {
	search: string
	scope: SecretFilterScope
	packageId: string
}

const secretsBasePath = '/account/secrets'
const secretsRoute = createListDetailRoute(secretsBasePath, {
	parseDetailId(pathname) {
		return parseAccountSecretPath(pathname)?.id ?? null
	},
})

function formatRelativeTtl(ttlMs: number | null) {
	if (ttlMs == null) return 'No expiry'
	const totalMinutes = Math.max(1, Math.round(ttlMs / 60_000))
	if (totalMinutes < 60) return `Expires in ${totalMinutes} min`
	const totalHours = Math.round(totalMinutes / 60)
	if (totalHours < 48) return `Expires in ${totalHours} hr`
	const totalDays = Math.round(totalHours / 24)
	return `Expires in ${totalDays} day${totalDays === 1 ? '' : 's'}`
}

function createEmptyEditorState(
	packageOptions: Array<PackageOption>,
): EditorState {
	return {
		currentId: null,
		name: '',
		scope: 'user',
		packageId: packageOptions[0]?.id ?? '',
		description: '',
		value: '',
		allowedHosts: [''],
		allowedCapabilities: [''],
		allowedPackages: [],
	}
}

function readNewSecretScope(value: string | null): SecretScope | null {
	return value === 'package' || value === 'user' ? value : null
}

function createEditorStateFromNewSecretQuery(
	packageOptions: Array<PackageOption>,
	href: string,
): EditorState {
	const params = new URL(href, 'http://localhost').searchParams
	const state = createEmptyEditorState(packageOptions)
	const requestedScope = readNewSecretScope(readTrimmedParam(params, 'scope'))
	const requestedPackageId = readTrimmedParam(params, 'packageId')
	const packageId =
		packageOptions.find(
			(packageOption) => packageOption.id === requestedPackageId,
		)?.id ??
		packageOptions[0]?.id ??
		''
	const scope: SecretScope =
		requestedScope ?? (requestedPackageId ? 'package' : 'user')
	const allowedHosts = normalizeAllowedHosts(
		readCommaListParams(params, ['allowedHosts', 'allowed-host']),
	)
	const allowedCapabilities = normalizeAllowedCapabilities(
		readCommaListParams(params, ['allowedCapabilities', 'capability']),
	)
	const allowedPackages = normalizeAllowedPackages(
		readCommaListParams(params, ['allowedPackages', 'package_id', 'package']),
	)

	return {
		...state,
		name: readTrimmedParam(params, 'name') ?? state.name,
		scope,
		packageId: scope === 'package' ? packageId : '',
		description: readTrimmedParam(params, 'description') ?? state.description,
		allowedHosts: allowedHosts.length > 0 ? allowedHosts : state.allowedHosts,
		allowedCapabilities:
			allowedCapabilities.length > 0
				? allowedCapabilities
				: state.allowedCapabilities,
		allowedPackages:
			scope === 'user' && allowedPackages.length > 0
				? allowedPackages
				: state.allowedPackages,
	}
}

function getNewSecretQueryKey(href: string) {
	const url = new URL(href, 'http://localhost')
	if (url.pathname !== `${secretsBasePath}/new`) return ''
	const keys = [
		'name',
		'description',
		'scope',
		'packageId',
		'allowedHosts',
		'allowed-host',
		'allowedCapabilities',
		'capability',
		'allowedPackages',
		'package_id',
		'package',
	]
	return keys
		.map((key) => `${key}=${url.searchParams.getAll(key).join('\u0000')}`)
		.join('&')
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

function createEditorStateFromSecret(secret: AccountSecretDetail): EditorState {
	const allowedHosts = coerceStringRows(secret.allowedHosts)
	const allowedCapabilities = coerceStringRows(secret.allowedCapabilities)
	const allowedPackages = coerceStringRows(secret.allowedPackages)
	return {
		currentId: secret.id,
		name: secret.name,
		scope: secret.scope,
		packageId: secret.packageId ?? '',
		description: secret.description,
		value: secret.value,
		allowedHosts: allowedHosts.length > 0 ? allowedHosts : [''],
		allowedCapabilities:
			allowedCapabilities.length > 0 ? allowedCapabilities : [''],
		allowedPackages,
	}
}

function buildSecretsHref(pathname: string, search: string) {
	return `${pathname}${search}`
}

function readRequestedCapability(href: string) {
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
	selectedSecret: AccountSecretDetail | null
	approval: ApprovalView | null
	formatPackageId: (packageId: string) => string
}) {
	const requestedHost = normalizeSingleAllowedHost(
		readRequestedHost(input.href),
	)
	const requestedCapability = normalizeSingleAllowedCapability(
		readRequestedCapability(input.href),
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
		: input.approval
			? normalizeAllowedCapabilities(
					coerceStringRows(input.approval.currentAllowedCapabilities),
				)
			: []
	const allowedPackageIds = input.selectedSecret
		? Array.from(
				new Set(
					coerceStringRows(input.selectedSecret.allowedPackages).filter(
						(value) => value.length > 0,
					),
				),
			).sort((left, right) => left.localeCompare(right))
		: input.approval
			? Array.from(
					new Set(
						coerceStringRows(input.approval.currentAllowedPackages).filter(
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
	const capabilityAlreadyAdded =
		requestedCapability != null &&
		requestedHost == null &&
		requestedPackageId == null &&
		allowedCapabilities.includes(requestedCapability)
	if (capabilityAlreadyAdded) {
		items.push(
			`Capability ${requestedCapability} is already in allowed capabilities.`,
		)
	}
	const packageAlreadyAdded =
		requestedPackageId != null && allowedPackageIds.includes(requestedPackageId)
	if (packageAlreadyAdded) {
		items.push(
			`Package ${input.formatPackageId(requestedPackageId)} is already in allowed packages.`,
		)
	}
	if (items.length === 0) return null
	return {
		items,
		hostAlreadyAdded,
		capabilityAlreadyAdded,
		packageAlreadyAdded,
	}
}

function buildSecretHref(
	secret: {
		name: string
		scope: SecretScope
		packageId: string | null
	},
	search: string,
) {
	return buildSecretsHref(
		buildAccountSecretPath({
			name: secret.name,
			scope: secret.scope,
			packageId: secret.packageId,
		}),
		search,
	)
}

function buildNewSecretHref(search = '') {
	return secretsRoute.buildNewHref(search)
}

function buildBaseSecretsHref(search = '') {
	return secretsRoute.buildListHref(search)
}

function getDataRefreshKey(href: string) {
	const url = new URL(href, 'http://localhost')
	const requestedHost = url.searchParams.get('allowed-host') ?? ''
	const requestedCapability = url.searchParams.get('capability') ?? ''
	const requestedPackageId = url.searchParams.get('package_id') ?? ''
	const requestedNames = [
		...url.searchParams.getAll('names'),
		...url.searchParams.getAll('name'),
	]
		.join(',')
		.trim()
	const newSecretQuery = getNewSecretQueryKey(href)
	return `${url.pathname}?allowed-host=${requestedHost}&capability=${requestedCapability}&package_id=${requestedPackageId}&names=${requestedNames}&new-secret=${newSecretQuery}`
}

function buildSecretsApiRequestUrl(href: string) {
	const pageUrl = new URL(href, 'http://localhost')
	const selection = secretsRoute.getSelection(href)
	const requestUrl = new URL(accountSecretsApiPath, 'http://localhost')
	requestUrl.search = pageUrl.search
	if (selection.selectedId) {
		requestUrl.searchParams.set('selected', selection.selectedId)
	} else {
		requestUrl.searchParams.delete('selected')
	}
	return requestUrl
}

export async function accountSecretsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const requestUrl = buildSecretsApiRequestUrl(href)
	const response = await fetch(`${requestUrl.pathname}${requestUrl.search}`, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountSecretsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load your secrets.')
	}
	return { accountSecrets: payload }
}

function readFilterState(
	href: string,
	packageOptions: Array<PackageOption>,
): SecretFilterState {
	const url = new URL(href, 'http://localhost')
	const search = url.searchParams.get('q')?.trim() ?? ''
	const rawScope = url.searchParams.get('scope')
	const scope =
		rawScope === 'user' || rawScope === 'package' ? rawScope : ('all' as const)
	const rawPackageId = url.searchParams.get('package')?.trim() ?? ''
	const packageId =
		scope === 'user'
			? ''
			: packageOptions.some(
						(packageOption) => packageOption.id === rawPackageId,
				  )
				? rawPackageId
				: ''
	return {
		search,
		scope,
		packageId,
	}
}

function filterSecrets(
	secrets: Array<AccountSecretListItem>,
	filters: SecretFilterState,
	packagesById: ReadonlyMap<string, { kodyId: string; name: string }>,
) {
	return secrets.filter((secret) => {
		if (filters.scope !== 'all' && secret.scope !== filters.scope) return false
		if (
			filters.scope !== 'user' &&
			filters.packageId &&
			secret.packageId !== filters.packageId
		)
			return false
		const allowedPackageNames = secret.allowedPackages.flatMap((packageId) => {
			const metadata = packagesById.get(packageId)
			return metadata ? [metadata.kodyId, metadata.name] : []
		})
		return matchesSearchQuery(filters.search, [
			secret.name,
			secret.description,
			secret.packageTitle ?? '',
			secret.scope,
			...secret.allowedHosts,
			...secret.allowedCapabilities,
			...secret.allowedPackages,
			...allowedPackageNames,
		])
	})
}

const truncatedTextCss = {
	minWidth: 0,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
} as const

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
		nextFilters: Partial<SecretFilterState>,
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
			const isCapabilityApproval =
				Boolean(approval.requestedCapability) &&
				!approval.requestedPackageId &&
				!approval.requestedHost
			applyPayload(
				payload,
				selection,
				action === 'approve'
					? approval.requestedPackageId
						? isBulkPackageApproval
							? `Approved package access for ${approval.names.length} secrets.`
							: 'Approved requested package.'
						: isCapabilityApproval
							? 'Approved requested capability.'
							: 'Approved requested host.'
					: approval.requestedPackageId
						? isBulkPackageApproval
							? 'Rejected bulk package approval request.'
							: 'Rejected package approval request.'
						: isCapabilityApproval
							? 'Rejected capability approval request.'
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
			const allowedCapabilities = normalizeAllowedCapabilities(
				collectRepeatedTextRows(form, 'allowed-capabilities'),
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
					value: submittedEditorState.value,
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
			!alreadyAddedNotice?.capabilityAlreadyAdded &&
			!alreadyAddedNotice?.packageAlreadyAdded
				? approval
				: null
		const requestedPackageMetadata = approvalCard?.requestedPackageId
			? packagesById.get(approvalCard.requestedPackageId)
			: null
		const isCapabilityApprovalCard =
			Boolean(approvalCard?.requestedCapability) &&
			!approvalCard?.requestedPackageId &&
			!approvalCard?.requestedHost

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Secrets"
					description="Create, update, and delete user secrets and package-owned secrets."
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

				{approvalCard ? (
					<section
						mix={css({
							display: 'grid',
							gap: spacing.md,
							padding: spacing.lg,
							borderRadius: radius.lg,
							border: `1px solid ${colors.primary}`,
							backgroundColor: colors.primarySoftest,
						})}
					>
						<div mix={css({ display: 'grid', gap: spacing.xs })}>
							<h2
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								})}
							>
								Approve secret access
							</h2>
							{approvalCard.requestedPackageId ? (
								<div mix={css({ display: 'grid', gap: spacing.xs })}>
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										Allow package{' '}
										<strong mix={css({ color: colors.text })}>
											{requestedPackageMetadata?.kodyId ?? 'Unknown package'}
										</strong>{' '}
										{approvalCard.names.length > 1 ? (
											<>
												to use these {approvalCard.names.length} secrets from
												the {getScopeLabel(approvalCard.scope)} scope.
											</>
										) : (
											<>
												to use secret <code>{approvalCard.name}</code> from the{' '}
												{getScopeLabel(approvalCard.scope)} scope.
											</>
										)}
									</p>
									<code mix={css({ color: colors.textMuted })}>
										{approvalCard.requestedPackageId}
									</code>
									{approvalCard.names.length > 1 ? (
										<ul
											mix={css({
												margin: 0,
												paddingLeft: spacing.lg,
												display: 'grid',
												gap: spacing.xs,
											})}
										>
											{approvalCard.names.map((secretName) => (
												<li key={secretName}>
													<code>{secretName}</code>
												</li>
											))}
										</ul>
									) : null}
								</div>
							) : isCapabilityApprovalCard ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Requested capability:{' '}
									<code>{approvalCard.requestedCapability}</code> for secret{' '}
									<code>{approvalCard.name}</code> from the{' '}
									{getScopeLabel(approvalCard.scope)} scope.
								</p>
							) : (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Allow <code>{approvalCard.requestedHost}</code> to receive
									secret <code>{approvalCard.name}</code> from the{' '}
									{getScopeLabel(approvalCard.scope)} scope.
								</p>
							)}
							{approvalCard.requestedCapability && !isCapabilityApprovalCard ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Requested capability:{' '}
									<code>{approvalCard.requestedCapability}</code>
								</p>
							) : null}
							{approvalCard.requestedPackageId ? (
								approvalCard.names.length > 1 ? null : (
									<div mix={css({ display: 'grid', gap: spacing.xs })}>
										<span mix={css({ color: colors.textMuted })}>
											Current allowed packages:
										</span>
										{approvalCard.currentAllowedPackages.length > 0 ? (
											<ul
												mix={css({
													margin: 0,
													paddingLeft: spacing.lg,
													display: 'grid',
													gap: spacing.xs,
												})}
											>
												{approvalCard.currentAllowedPackages.map(
													(packageId) => {
														const metadata = packagesById.get(packageId)
														return (
															<li key={packageId}>
																<span mix={css(packageIdentityCss)}>
																	<strong>
																		{metadata?.kodyId ?? 'Unknown package'}
																	</strong>
																	<code>{packageId}</code>
																</span>
															</li>
														)
													},
												)}
											</ul>
										) : (
											<span mix={css({ color: colors.textMuted })}>None</span>
										)}
									</div>
								)
							) : isCapabilityApprovalCard ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Current allowed capabilities:{' '}
									{approvalCard.currentAllowedCapabilities.length > 0
										? approvalCard.currentAllowedCapabilities.join(', ')
										: 'none'}
								</p>
							) : (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Current allowed hosts:{' '}
									{approvalCard.currentAllowedHosts.length > 0
										? approvalCard.currentAllowedHosts.join(', ')
										: 'none'}
								</p>
							)}
						</div>
						<div
							mix={css({ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' })}
						>
							<button
								type="button"
								disabled={isMutating || isRefreshingForLocationChange}
								mix={[
									on('click', () => void submitApproval('approve')),
									css(primaryButtonCss),
								]}
							>
								{approvalCard.requestedPackageId &&
								approvalCard.names.length > 1
									? `Approve all (${approvalCard.names.length})`
									: 'Approve'}
							</button>
							<button
								type="button"
								disabled={isMutating || isRefreshingForLocationChange}
								mix={[
									on('click', () => void submitApproval('reject')),
									css(secondaryButtonCss),
								]}
							>
								Reject
							</button>
						</div>
					</section>
				) : null}
				{alreadyAddedNotice ? (
					<section
						role="status"
						mix={css({
							display: 'grid',
							gap: spacing.sm,
							padding: spacing.lg,
							borderRadius: radius.lg,
							border: `1px solid ${colors.primary}`,
							backgroundColor: colors.primarySoftest,
						})}
					>
						<div mix={css({ display: 'grid', gap: spacing.xs })}>
							<h2
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								})}
							>
								Already added
							</h2>
							<p mix={css({ margin: 0, color: colors.textMuted })}>
								This request is already complete for this secret.
							</p>
						</div>
						<ul
							mix={css({
								margin: 0,
								paddingLeft: spacing.lg,
								color: colors.textMuted,
								display: 'grid',
								gap: spacing.xs,
							})}
						>
							{alreadyAddedNotice.items.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					</section>
				) : null}

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

				<AccountManagementLayout
					sidebar={
						<AccountManagementSidebar
							title="Saved secrets"
							description="Select a secret to edit its metadata, value, and allowed hosts."
						>
							<div
								mix={css({
									display: 'grid',
									gap: spacing.sm,
								})}
							>
								<AccountManagementSearchField
									label="Search"
									placeholder="Search secrets"
									value={filters.search}
									onInput={(value) => {
										replaceLocation(
											buildHrefWithUpdatedFilters({ search: value }),
										)
									}}
								/>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Scope</span>
									<select
										value={filters.scope}
										aria-label="Filter secrets by scope"
										mix={[
											on(
												'change',

												(event) => {
													const nextScope = event.currentTarget
														.value as SecretFilterScope
													replaceLocation(
														buildHrefWithUpdatedFilters({
															scope: nextScope,
															packageId:
																nextScope === 'user' ? '' : filters.packageId,
														}),
													)
												},
											),

											css(inputCss),
										]}
									>
										<option value="all">All scopes</option>
										<option value="user">User</option>
										<option value="package">Package</option>
									</select>
								</label>
								{packageOptions.length > 0 ? (
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
								) : null}
							</div>
							{status === 'ready' && secrets.length === 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									No secrets yet. Create one to get started.
								</p>
							) : status === 'ready' && filteredSecrets.length === 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									No secrets match the current filters.
								</p>
							) : (
								<AccountManagementList>
									{filteredSecrets.map((secret) => {
										const isActive = activeSecretId === secret.id
										return (
											<li key={secret.id} mix={css({ minWidth: 0 })}>
												<AccountManagementListItemButton
													active={isActive}
													disabled={isMutating}
													onClick={() => {
														if (isMutating) return
														navigate(
															buildSecretHref(secret, getCurrentSearch()),
														)
													}}
												>
													<div
														mix={css({
															display: 'grid',
															gridTemplateColumns: 'minmax(0, 1fr) auto',
															gap: spacing.md,
															alignItems: 'baseline',
															minWidth: 0,
														})}
													>
														<strong
															mix={css({
																...truncatedTextCss,
																display: 'block',
															})}
														>
															{secret.name}
														</strong>
														<span
															mix={css({
																fontSize: typography.fontSize.xs,
																color: colors.textMuted,
															})}
														>
															{formatRelativeTtl(secret.ttlMs)}
														</span>
													</div>
													<span
														mix={css({
															...truncatedTextCss,
															display: 'block',
															fontSize: typography.fontSize.sm,
															color: colors.textMuted,
														})}
													>
														{getScopeLabel(secret.scope)}
														{secret.packageTitle
															? ` - ${secret.packageTitle}`
															: ''}
													</span>
													{secret.description ? (
														<span
															mix={css({
																display: '-webkit-box',
																fontSize: typography.fontSize.sm,
																color: colors.textMuted,
																overflow: 'hidden',
																overflowWrap: 'anywhere',
																textOverflow: 'ellipsis',
																'-webkit-box-orient': 'vertical',
																'-webkit-line-clamp': '2',
															})}
														>
															{secret.description}
														</span>
													) : null}
												</AccountManagementListItemButton>
											</li>
										)
									})}
								</AccountManagementList>
							)}
						</AccountManagementSidebar>
					}
				>
					<div
						mix={css({
							...cardCss,
							gap: spacing.lg,
						})}
					>
						{showEditor ? (
							<form
								{...passwordManagerIgnoreProps}
								mix={[
									css({ display: 'grid', gap: spacing.lg }),
									on('submit', saveSecretChanges),
								]}
							>
								<div mix={css({ display: 'grid', gap: spacing.xs })}>
									<h2
										mix={css({
											margin: 0,
											fontSize: typography.fontSize.lg,
											fontWeight: typography.fontWeight.semibold,
											color: colors.text,
										})}
									>
										{selection.isCreating ? 'New secret' : selectedSecret?.name}
									</h2>
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										{selection.isCreating
											? 'Create a new user or package secret.'
											: 'Update the secret value and metadata for this entry.'}
									</p>
								</div>

								<div
									mix={css({
										display: 'grid',
										gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
										gap: spacing.md,
										[mq.mobile]: {
											gridTemplateColumns: '1fr',
										},
									})}
								>
									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Name</span>
										<input
											type="text"
											required
											value={editorState.name}
											placeholder="api-token"
											mix={[
												on(
													'input',

													(event) => {
														editorState = {
															...editorState,
															name: event.currentTarget.value,
														}
														handle.update()
													},
												),

												css(inputCss),
											]}
										/>
									</label>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Scope</span>
										<select
											value={editorState.scope}
											mix={[
												on(
													'change',

													(event) => {
														const scope = event.currentTarget
															.value as SecretScope
														editorState = {
															...editorState,
															scope,
															packageId:
																scope === 'package'
																	? editorState.packageId ||
																		packageOptions[0]?.id ||
																		''
																	: '',
														}
														handle.update()
													},
												),

												css(inputCss),
											]}
										>
											<option value="user">User</option>
											{canCreatePackageSecrets ? (
												<option value="package">Package</option>
											) : null}
										</select>
									</label>
								</div>

								{editorState.scope === 'package' ? (
									<Combobox
										key={`secret-editor-package:${editorState.packageId}`}
										id="secret-editor-package"
										label="Package"
										placeholder="Choose a package"
										value={editorState.packageId}
										options={packageSelectOptions}
										onChange={(packageId) => {
											editorState = {
												...editorState,
												packageId,
											}
											handle.update()
										}}
									/>
								) : null}

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

								{editorState.scope === 'user' ? (
									<div mix={css({ display: 'grid', gap: spacing.sm })}>
										<div mix={css({ display: 'grid', gap: spacing.xs })}>
											<span mix={css(fieldLabelCss)}>Allowed packages</span>
											<p mix={css({ margin: 0, color: colors.textMuted })}>
												Only selected packages may access this user secret from
												package runtimes.
											</p>
										</div>
										{editorState.allowedPackages.length > 0 ? (
											<div mix={css({ display: 'grid', gap: spacing.sm })}>
												{editorState.allowedPackages.map((packageId) => {
													const metadata = packagesById.get(packageId)
													const packageLabel =
														metadata?.kodyId ?? 'Unknown package'
													return (
														<div
															key={packageId}
															mix={css({
																display: 'grid',
																gridTemplateColumns: 'minmax(0, 1fr) auto',
																gap: spacing.sm,
																alignItems: 'center',
																padding: spacing.sm,
																border: `1px solid ${colors.border}`,
																borderRadius: radius.md,
															})}
														>
															<span mix={css(packageIdentityCss)}>
																<strong>{packageLabel}</strong>
																<code>{packageId}</code>
															</span>
															<button
																type="button"
																aria-label={`Remove package ${packageLabel}`}
																mix={[
																	on(
																		'click',

																		() => removeAllowedPackage(packageId),
																	),

																	css(secondaryButtonCss),
																]}
															>
																Remove
															</button>
														</div>
													)
												})}
											</div>
										) : (
											<p mix={css({ margin: 0, color: colors.textMuted })}>
												No packages currently have access.
											</p>
										)}
										{availableAllowedPackageOptions.length > 0 ? (
											<Combobox
												key={`allowed-package-picker:${editorState.allowedPackages.join(',')}`}
												id="secret-allowed-package"
												label="Add allowed package"
												placeholder="Search saved packages"
												value=""
												options={availableAllowedPackageOptions}
												onChange={addAllowedPackage}
											/>
										) : packageOptions.length > 0 ? (
											<p mix={css({ margin: 0, color: colors.textMuted })}>
												All saved packages are already allowed.
											</p>
										) : null}
									</div>
								) : null}

								{selectedSecret ? (
									<MetadataGrid
										columns={3}
										items={[
											{
												label: 'Created',
												value: formatTimestamp(selectedSecret.createdAt),
											},
											{
												label: 'Updated',
												value: formatTimestamp(selectedSecret.updatedAt),
											},
											{
												label: 'Expiry',
												value: formatRelativeTtl(selectedSecret.ttlMs),
											},
										]}
									/>
								) : null}

								<div
									mix={css({
										display: 'flex',
										gap: spacing.sm,
										flexWrap: 'wrap',
									})}
								>
									<button
										type="submit"
										disabled={
											isMutating ||
											(editorState.scope === 'package' &&
												!editorState.packageId)
										}
										mix={css(primaryButtonCss)}
									>
										{saveState === 'saving' ? 'Saving...' : 'Save'}
									</button>
									{editorState.currentId ? (
										<button
											type="button"
											disabled={isMutating}
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
											mix={[
												...deleteSecretCheck.getButtonMix({
													on: {
														click: () => void deleteSelectedSecret(),
													},
												}),
												css(dangerButtonCss),
											]}
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
							<div mix={css({ display: 'grid', gap: spacing.sm })}>
								<h2
									mix={css({
										margin: 0,
										fontSize: typography.fontSize.lg,
										fontWeight: typography.fontWeight.semibold,
										color: colors.text,
									})}
								>
									Select a secret
								</h2>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Pick a secret from the list to edit it, or create a new one.
								</p>
							</div>
						)}
					</div>
				</AccountManagementLayout>
			</AccountManagementShell>
		)
	}
}

const packageIdentityCss = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
	'& code': {
		color: colors.textMuted,
		overflowWrap: 'anywhere' as const,
	},
}

const primaryButtonCss = getPrimaryButtonCss()
const secondaryButtonCss = getSecondaryButtonCss()
const dangerButtonCss = getDangerButtonCss()
