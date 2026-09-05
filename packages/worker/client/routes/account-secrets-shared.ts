import { readCommaListParams, readTrimmedParam } from '#client/url-params.ts'
import {
	type AccountSecretDetail,
	type AccountSecretListItem,
	type AccountSecretsLoaderData,
} from '#universal/loader-data.ts'
import {
	buildAccountSecretPath,
	parseAccountSecretPath,
} from '@kody-internal/shared/account-secret-route.ts'
import { normalizeSecretExpiresAt } from '@kody-internal/shared/secret-expires-at.ts'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	type ApprovalView,
	accountSecretsApiPath,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import { matchesSearchQuery } from '#client/search-filter.ts'
import { getNewSecretQueryKey } from './new-secret-query.ts'
import {
	normalizeAllowedHosts,
	normalizeAllowedPackages,
} from './secret-normalization.ts'

export type SecretScope = AccountSecretListItem['scope']

export type PackageOption = AccountSecretsLoaderData['packageOptions'][number]

export type EditorState = {
	currentId: string | null
	name: string
	scope: SecretScope
	packageId: string
	description: string
	expiresAt: string
	value: string
	allowedHosts: Array<string>
	allowedPackages: Array<string>
}

export type SecretFilterScope = 'all' | 'user' | 'package'

export type SecretFilterState = {
	search: string
	scope: SecretFilterScope
	packageId: string
}

export const secretsBasePath = '/account/secrets'
export const secretsRoute = createListDetailRoute(secretsBasePath, {
	parseDetailId(pathname) {
		return parseAccountSecretPath(pathname)?.id ?? null
	},
})

export function formatRelativeTtl(ttlMs: number | null) {
	if (ttlMs == null) return 'No expiry'
	if (ttlMs <= 0) return 'Expired'
	const totalMinutes = Math.max(1, Math.round(ttlMs / 60_000))
	if (totalMinutes < 60) return `Expires in ${totalMinutes} min`
	const totalHours = Math.round(totalMinutes / 60)
	if (totalHours < 48) return `Expires in ${totalHours} hr`
	const totalDays = Math.round(totalHours / 24)
	return `Expires in ${totalDays} day${totalDays === 1 ? '' : 's'}`
}

export function createEmptyEditorState(
	packageOptions: Array<PackageOption>,
): EditorState {
	return {
		currentId: null,
		name: '',
		scope: 'user',
		packageId: packageOptions[0]?.id ?? '',
		description: '',
		expiresAt: '',
		value: '',
		allowedHosts: [''],
		allowedPackages: [],
	}
}

function readNewSecretScope(value: string | null): SecretScope | null {
	return value === 'package' || value === 'user' ? value : null
}

function readNewSecretExpiresAt(params: URLSearchParams) {
	const value = readTrimmedParam(params, 'expiresAt')
	if (!value) return null
	try {
		return normalizeSecretExpiresAt(value) ?? ''
	} catch {
		return null
	}
}

export function createEditorStateFromNewSecretQuery(
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
	const allowedPackages = normalizeAllowedPackages(
		readCommaListParams(params, ['allowedPackages', 'package_id', 'package']),
	)

	return {
		...state,
		name: readTrimmedParam(params, 'name') ?? state.name,
		scope,
		packageId: scope === 'package' ? packageId : '',
		description: readTrimmedParam(params, 'description') ?? state.description,
		expiresAt: readNewSecretExpiresAt(params) ?? state.expiresAt,
		allowedHosts: allowedHosts.length > 0 ? allowedHosts : state.allowedHosts,
		allowedPackages:
			scope === 'user' && allowedPackages.length > 0
				? allowedPackages
				: state.allowedPackages,
	}
}

export function coerceStringRows(list: Array<unknown>): Array<string> {
	return list.filter((item): item is string => typeof item === 'string')
}

export function collectRepeatedTextRows(
	form: HTMLFormElement,
	listName: 'allowed-hosts',
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

export function createEditorStateFromSecret(
	secret: AccountSecretDetail,
): EditorState {
	const allowedHosts = coerceStringRows(secret.allowedHosts)
	const allowedPackages = coerceStringRows(secret.allowedPackages)
	return {
		currentId: secret.id,
		name: secret.name,
		scope: secret.scope,
		packageId: secret.packageId ?? '',
		description: secret.description,
		expiresAt: secret.expiresAt ?? '',
		value: secret.value,
		allowedHosts: allowedHosts.length > 0 ? allowedHosts : [''],
		allowedPackages,
	}
}

function buildSecretsHref(pathname: string, search: string) {
	return `${pathname}${search}`
}

function readRequestedHosts(href: string) {
	const url = new URL(href, 'http://localhost')
	const values = [
		...url.searchParams.getAll('hosts'),
		...url.searchParams.getAll('host'),
		...url.searchParams.getAll('allowed-host'),
		...url.searchParams.getAll('allowedHosts'),
	]
	return normalizeAllowedHosts(values.flatMap((value) => value.split(',')))
}

export function getAlreadyAddedNotice(input: {
	href: string
	selectedSecret: AccountSecretDetail | null
	approval: ApprovalView | null
	formatPackageId: (packageId: string) => string
}) {
	const requestedHosts = readRequestedHosts(input.href)
	const requestedPackageId =
		new URL(input.href, 'http://localhost').searchParams
			.get('package_id')
			?.trim() ?? null
	const allowedHosts = input.selectedSecret
		? normalizeAllowedHosts(coerceStringRows(input.selectedSecret.allowedHosts))
		: input.approval
			? normalizeAllowedHosts(input.approval.currentAllowedHosts)
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
	const alreadyAllowedHosts = requestedHosts.filter((host) =>
		allowedHosts.includes(host),
	)
	const hostAlreadyAdded =
		requestedHosts.length > 0 &&
		alreadyAllowedHosts.length === requestedHosts.length
	if (hostAlreadyAdded) {
		items.push(
			requestedHosts.length === 1
				? `Host ${requestedHosts[0]} is already in allowed hosts.`
				: `Hosts ${requestedHosts.join(', ')} are already in allowed hosts.`,
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
		packageAlreadyAdded,
	}
}

export function buildSecretHref(
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

export function buildNewSecretHref(search = '') {
	return secretsRoute.buildNewHref(search)
}

export function buildBaseSecretsHref(search = '') {
	return secretsRoute.buildListHref(search)
}

export function getDataRefreshKey(href: string) {
	const url = new URL(href, 'http://localhost')
	const requestedHost = [
		url.searchParams.get('allowed-host') ?? '',
		url.searchParams.get('hosts') ?? '',
	].join(',')
	const requestedPackageId = url.searchParams.get('package_id') ?? ''
	const requestedNames = [
		...url.searchParams.getAll('names'),
		...url.searchParams.getAll('name'),
	]
		.join(',')
		.trim()
	const newSecretQuery = getNewSecretQueryKey(href)
	return `${url.pathname}?allowed-host=${requestedHost}&package_id=${requestedPackageId}&names=${requestedNames}&new-secret=${newSecretQuery}`
}

export function buildSecretsApiRequestUrl(href: string) {
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

export function readFilterState(
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

export function filterSecrets(
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
			...secret.allowedPackages,
			...allowedPackageNames,
		])
	})
}
