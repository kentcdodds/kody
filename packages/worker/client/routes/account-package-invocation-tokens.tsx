import {
	formatNullableTimestamp,
	formatTimestamp,
} from '#client/format-timestamp.ts'
import { readCommaListParams, readTrimmedParam } from '#client/url-params.ts'
import { bytesToBase64Url } from '@kody-internal/shared/base64.ts'
import {
	type AccountPackageInvocationTokenListItem,
	type AccountPackageInvocationTokensLoaderData,
} from '#app/loader-data.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { createDoubleCheck } from '#client/double-check.ts'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { matchesSearchQuery } from '#client/search-filter.ts'
import { writeClipboardText } from '#client/clipboard.ts'
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
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#client/styles/style-primitives.ts'
import {
	AccountManagementLayout,
	AccountManagementList,
	AccountManagementListItemLink,
	AccountManagementMessage,
	AccountManagementSearchField,
	AccountManagementShell,
	AccountManagementSidebar,
	AccountPageHeader,
	MetadataGrid,
	accountInputCss,
	accountTextareaCss,
} from './account-management-components.tsx'

type PackageOption =
	AccountPackageInvocationTokensLoaderData['packages'][number]

type EditorState = {
	name: string
	rawToken: string
	packageIdsText: string
	packageKodyIdsText: string
	exportNamesText: string
	sourcesText: string
}

const accountPackageInvocationTokensApiPath =
	'/account/package-invocation-tokens.json'
const accountPackageInvocationTokensBasePath =
	'/account/package-invocation-tokens'
const packageInvocationTokensRoute = createListDetailRoute(
	accountPackageInvocationTokensBasePath,
)
const wildcardScope = '*'

/**
 * Latch key for the list payload. Selection segments and the client-side `q`
 * filter do not change the GET response, so keying the latch on the base path
 * avoids spurious refetches when only those URL parts change.
 */
function getDataLatchKey(_href: string) {
	return accountPackageInvocationTokensBasePath
}

function readFilterState(href: string) {
	return {
		search:
			new URL(href, 'http://localhost').searchParams.get('q')?.trim() ?? '',
	}
}

const truncatedTextCss = {
	minWidth: 0,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
} as const

function createEmptyEditorState(): EditorState {
	return {
		name: '',
		rawToken: '',
		packageIdsText: '',
		packageKodyIdsText: '',
		exportNamesText: '',
		sourcesText: '',
	}
}
function createEditorStateFromNewTokenQuery(href: string): EditorState {
	const params = new URL(href, 'http://localhost').searchParams
	const state = createEmptyEditorState()
	const packageIds = readCommaListParams(params, [
		'packageId',
		'packageIds',
		'package_id',
		'package_ids',
		'package-id',
		'package-ids',
	])
	const packageKodyIds = readCommaListParams(params, [
		'packageKodyId',
		'packageKodyIds',
		'package_kody_id',
		'package_kody_ids',
		'package-kody-id',
		'package-kody-ids',
		'kodyId',
		'kodyIds',
		'kody_id',
		'kody_ids',
		'kody-id',
		'kody-ids',
	])
	const exportNames = readCommaListParams(params, [
		'exportName',
		'exportNames',
		'export_name',
		'export_names',
		'export-name',
		'export-names',
	])
	const sources = readCommaListParams(params, [
		'source',
		'sources',
		'source_name',
		'source_names',
		'source-name',
		'source-names',
		'allowedSource',
		'allowedSources',
		'allowed_source',
		'allowed_sources',
		'allowed-source',
		'allowed-sources',
	])
	return {
		...state,
		name: readTrimmedParam(params, 'name') ?? state.name,
		packageIdsText: packageIds.join('\n'),
		packageKodyIdsText: packageKodyIds.join('\n'),
		exportNamesText: exportNames.join('\n'),
		sourcesText: sources.join('\n'),
	}
}

export async function accountPackageInvocationTokensRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(accountPackageInvocationTokensApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload =
		await readJson<AccountPackageInvocationTokensLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load package invocation tokens.')
	}
	return { accountPackageInvocationTokens: payload }
}

function getNewTokenQueryKey(href: string) {
	const url = new URL(href, 'http://localhost')
	if (url.pathname !== `${accountPackageInvocationTokensBasePath}/new`)
		return ''
	const keys = [
		'name',
		'packageId',
		'packageIds',
		'package_id',
		'package_ids',
		'package-id',
		'package-ids',
		'packageKodyId',
		'packageKodyIds',
		'package_kody_id',
		'package_kody_ids',
		'package-kody-id',
		'package-kody-ids',
		'kodyId',
		'kodyIds',
		'kody_id',
		'kody_ids',
		'kody-id',
		'kody-ids',
		'exportName',
		'exportNames',
		'export_name',
		'export_names',
		'export-name',
		'export-names',
		'source',
		'sources',
		'source_name',
		'source_names',
		'source-name',
		'source-names',
		'allowedSource',
		'allowedSources',
		'allowed_source',
		'allowed_sources',
		'allowed-source',
		'allowed-sources',
	]
	return keys
		.map((key) => `${key}=${url.searchParams.getAll(key).join('\u0000')}`)
		.join('&')
}

function parseListText(value: string) {
	return value
		.split(/[\n,]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

function generatePackageInvocationRawToken() {
	const cryptoApi = globalThis.crypto
	if (!cryptoApi?.getRandomValues) {
		throw new Error('This browser cannot generate secure random tokens.')
	}
	const bytes = new Uint8Array(32)
	cryptoApi.getRandomValues(bytes)
	return `kody_${bytesToBase64Url(bytes)}`
}

function formatScope(values: Array<string>) {
	if (values.length === 0) return 'None'
	if (values.includes(wildcardScope)) return 'Any'
	return values.join(', ')
}

function tokenStatus(token: AccountPackageInvocationTokenListItem) {
	return token.revokedAt ? 'Revoked' : 'Active'
}

function filterTokens(
	tokens: Array<AccountPackageInvocationTokenListItem>,
	search: string,
	packages: Array<PackageOption>,
) {
	return tokens.filter((token) => {
		const packageNames = packages
			.filter(
				(pkg) =>
					token.packageIds.includes(pkg.id) ||
					token.packageIds.includes(wildcardScope) ||
					token.packageKodyIds.includes(pkg.kodyId) ||
					token.packageKodyIds.includes(wildcardScope),
			)
			.flatMap((pkg) => [pkg.name, pkg.kodyId])
		return matchesSearchQuery(search, [
			token.name,
			tokenStatus(token),
			...token.packageIds,
			...token.packageKodyIds,
			...token.exportNames,
			...token.sources,
			...packageNames,
		])
	})
}

function tokenPackageSummary(token: AccountPackageInvocationTokenListItem) {
	const scopes = [...token.packageIds, ...token.packageKodyIds]
	if (scopes.includes(wildcardScope)) return 'Any package'
	const count = scopes.length
	if (count === 0) return 'No packages'
	return `${count} package${count === 1 ? '' : 's'}`
}

function tokenStatusCss(token: AccountPackageInvocationTokenListItem) {
	return {
		display: 'inline-flex',
		alignItems: 'center',
		width: 'max-content',
		padding: `${spacing.xs} ${spacing.sm}`,
		borderRadius: radius.full,
		fontSize: typography.fontSize.sm,
		fontWeight: typography.fontWeight.medium,
		backgroundColor: token.revokedAt
			? 'color-mix(in srgb, var(--color-danger) 8%, transparent)'
			: colors.primarySoftest,
		color: token.revokedAt ? colors.error : colors.primaryText,
	}
}

function createEditorStateFromToken(
	token: AccountPackageInvocationTokenListItem,
): EditorState {
	return {
		name: token.name,
		rawToken: '',
		packageIdsText: token.packageIds.join('\n'),
		packageKodyIdsText: token.packageKodyIds.join('\n'),
		exportNamesText: token.exportNames.join('\n'),
		sourcesText: token.sources.join('\n'),
	}
}

export function AccountPackageInvocationTokensRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let saveState:
		| 'idle'
		| 'creating'
		| 'updating'
		| 'revoking'
		| 'reinstating'
		| 'deleting' = 'idle'
	let username = ''
	let invocationUrlOrigin = ''
	let packages: Array<PackageOption> = []
	let tokens: Array<AccountPackageInvocationTokenListItem> = []
	let editorState = createEmptyEditorState()
	let selectedTokenId: string | null = null
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	const loadLatch = createRouteLoadLatch()
	let lastNewTokenQueryKey = ''
	let mutationVersion = 0
	let revokeConfirm = false
	const deleteTokenCheck = createDoubleCheck(handle)
	let editMode = false

	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

	function redirectToLogin() {
		saveState = 'idle'
		status = 'ready'
		if (typeof window !== 'undefined') {
			window.location.assign('/login')
		}
	}

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

	function getCurrentSelectedTokenId() {
		return (
			packageInvocationTokensRoute.getSelection(getCurrentHref()).selectedId ??
			selectedTokenId
		)
	}

	function syncRouterLocation(nextPath: string) {
		// Do not pre-mark the destination as loaded: `navigate` is async
		// (preload-then-commit), so until it commits the current href is
		// unchanged and a pre-set would make interim renders look like a
		// location change and fire a spurious fallback fetch for the old URL.
		// The commit render consumes the navigation's preloaded data (or the
		// stale marker) and marks the latch itself.
		navigate(nextPath)
	}

	async function loadTokens(signal: AbortSignal) {
		const loadStartedAtMutationVersion = mutationVersion
		const href = getCurrentHref()
		const latchKey = getDataLatchKey(href)
		try {
			const response = await fetch(accountPackageInvocationTokensApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				redirectToLogin()
				return
			}
			const payload =
				await readJson<AccountPackageInvocationTokensLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load package invocation tokens.')
			}
			if (loadStartedAtMutationVersion !== mutationVersion) return
			if (getDataLatchKey(getCurrentHref()) !== latchKey) return
			applyPayload(payload, getCurrentHref())
			status = 'ready'
			message = null
			messageTone = 'info'
			loadLatch.markLoaded(latchKey)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			if (loadStartedAtMutationVersion !== mutationVersion) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load package invocation tokens.'
			messageTone = 'error'
			loadLatch.markFailed(latchKey)
			handle.update()
		}
	}

	function applyPayload(
		payload: AccountPackageInvocationTokensLoaderData,
		href: string,
	) {
		username = payload.username
		invocationUrlOrigin = payload.invocationUrlOrigin
		packages = payload.packages
		tokens = payload.tokens
		revokeConfirm = false
		deleteTokenCheck.reset()
		if (payload.selectedTokenId) {
			selectedTokenId = payload.selectedTokenId
			const selectedToken = tokens.find(
				(token) => token.id === payload.selectedTokenId,
			)
			editorState =
				selectedToken && !selectedToken.revokedAt
					? createEditorStateFromToken(selectedToken)
					: createEmptyEditorState()
			lastNewTokenQueryKey = ''
			editMode = Boolean(selectedToken && !selectedToken.revokedAt)
			return
		}
		const selection = packageInvocationTokensRoute.getSelection(href)
		if (selection.isCreating) {
			const queryKey = getNewTokenQueryKey(href)
			if (queryKey !== lastNewTokenQueryKey) {
				lastNewTokenQueryKey = queryKey
				editorState = createEditorStateFromNewTokenQuery(href)
				selectedTokenId = null
				editMode = false
			}
			return
		}
		if (selection.selectedId) {
			selectedTokenId = selection.selectedId
			const selectedToken = tokens.find(
				(token) => token.id === selection.selectedId,
			)
			editorState =
				selectedToken && !selectedToken.revokedAt
					? createEditorStateFromToken(selectedToken)
					: createEmptyEditorState()
			lastNewTokenQueryKey = ''
			editMode = Boolean(selectedToken && !selectedToken.revokedAt)
			return
		}
		editorState = createEmptyEditorState()
		lastNewTokenQueryKey = ''
		editMode = false
		selectedTokenId = null
	}

	function setEditorField(field: keyof EditorState, value: string) {
		editorState = {
			...editorState,
			[field]: value,
		}
	}

	function generateEditorRawToken() {
		try {
			setEditorField('rawToken', generatePackageInvocationRawToken())
			message =
				'Generated a raw token. Copy, save, or deliver it now; Kody will not show it again after saving.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to generate a secure token.'
			messageTone = 'error'
		}
		handle.update()
	}

	async function copyEditorRawToken() {
		if (!editorState.rawToken || saveState !== 'idle') return
		try {
			await writeClipboardText(editorState.rawToken)
			message = 'Copied raw token to clipboard.'
			messageTone = 'info'
		} catch {
			message = 'Unable to copy token. Select the field and copy it manually.'
			messageTone = 'error'
		}
		handle.update()
	}

	function readEditorStateFromForm(form: HTMLFormElement) {
		const formData = new FormData(form)
		return {
			name: String(formData.get('name') ?? '').trim(),
			rawToken: String(formData.get('rawToken') ?? '').trim(),
			packageIdsText: String(formData.get('packageIds') ?? ''),
			packageKodyIdsText: String(formData.get('packageKodyIds') ?? ''),
			exportNamesText: String(formData.get('exportNames') ?? ''),
			sourcesText: String(formData.get('sources') ?? ''),
		} satisfies EditorState
	}

	function startNewToken() {
		editorState = createEmptyEditorState()
		selectedTokenId = null
		revokeConfirm = false
		deleteTokenCheck.reset()
		editMode = false
		message = null
		messageTone = 'info'
		const nextPath =
			packageInvocationTokensRoute.buildNewHref(getCurrentSearch())
		syncRouterLocation(nextPath)
		lastNewTokenQueryKey = getNewTokenQueryKey(nextPath)
		handle.update()
	}

	function startEditToken(token: AccountPackageInvocationTokenListItem) {
		if (token.revokedAt) return
		editorState = createEditorStateFromToken(token)
		selectedTokenId = token.id
		editMode = true
		revokeConfirm = false
		deleteTokenCheck.reset()
		message = null
		messageTone = 'info'
		handle.update()
	}

	function cancelEditToken() {
		const tokenId = getCurrentSelectedTokenId()
		selectedTokenId = tokenId
		editorState = createEmptyEditorState()
		editMode = false
		revokeConfirm = false
		deleteTokenCheck.reset()
		message = null
		messageTone = 'info'
		syncRouterLocation(
			tokenId
				? packageInvocationTokensRoute.buildDetailHref(
						tokenId,
						getCurrentSearch(),
					)
				: packageInvocationTokensRoute.buildListHref(getCurrentSearch()),
		)
		handle.update()
	}

	async function createToken(form?: HTMLFormElement) {
		if (saveState !== 'idle') return
		const nextEditorState = form ? readEditorStateFromForm(form) : editorState
		editorState = nextEditorState
		const packageIds = parseListText(nextEditorState.packageIdsText)
		const packageKodyIds = parseListText(nextEditorState.packageKodyIdsText)
		const exportNames = parseListText(nextEditorState.exportNamesText)
		const sources = parseListText(nextEditorState.sourcesText)

		if (!nextEditorState.name) {
			message = 'Token name is required.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (!nextEditorState.rawToken) {
			message = 'Paste the raw token before creating it.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (packageIds.length === 0 && packageKodyIds.length === 0) {
			message =
				'Add at least one package id, Kody id, or wildcard package scope.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (exportNames.length === 0) {
			message = 'Add at least one export name or wildcard export scope.'
			messageTone = 'error'
			handle.update()
			return
		}

		saveState = 'creating'
		message = null
		messageTone = 'info'
		handle.update()
		try {
			const response = await fetch(accountPackageInvocationTokensApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'create',
					name: nextEditorState.name,
					rawToken: nextEditorState.rawToken,
					packageIds,
					packageKodyIds,
					exportNames,
					sources,
				}),
			})
			if (response.status === 401) {
				redirectToLogin()
				return
			}
			const payload = await readJson<
				AccountPackageInvocationTokensLoaderData & {
					error?: string
					ok?: boolean
				}
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to create token.')
			}
			mutationVersion += 1
			applyPayload(
				payload,
				packageInvocationTokensRoute.buildListHref(getCurrentSearch()),
			)
			saveState = 'idle'
			message =
				'Created token. The raw token was not stored and will not be shown again.'
			messageTone = 'info'
			const nextPath = payload.selectedTokenId
				? packageInvocationTokensRoute.buildDetailHref(
						payload.selectedTokenId,
						getCurrentSearch(),
					)
				: packageInvocationTokensRoute.buildListHref(getCurrentSearch())
			syncRouterLocation(nextPath)
			handle.update()
		} catch (error) {
			saveState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to create token.'
			messageTone = 'error'
			handle.update()
		}
	}

	async function updateSelectedToken(form?: HTMLFormElement) {
		const tokenId = getCurrentSelectedTokenId()
		if (!tokenId || saveState !== 'idle') return
		const nextEditorState = form ? readEditorStateFromForm(form) : editorState
		editorState = nextEditorState
		const packageIds = parseListText(nextEditorState.packageIdsText)
		const packageKodyIds = parseListText(nextEditorState.packageKodyIdsText)
		const exportNames = parseListText(nextEditorState.exportNamesText)
		const sources = parseListText(nextEditorState.sourcesText)

		if (!nextEditorState.name) {
			message = 'Token name is required.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (packageIds.length === 0 && packageKodyIds.length === 0) {
			message =
				'Add at least one package id, Kody id, or wildcard package scope.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (exportNames.length === 0) {
			message = 'Add at least one export name or wildcard export scope.'
			messageTone = 'error'
			handle.update()
			return
		}

		saveState = 'updating'
		message = null
		messageTone = 'info'
		handle.update()
		try {
			const response = await fetch(accountPackageInvocationTokensApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'update',
					id: tokenId,
					name: nextEditorState.name,
					rawToken: nextEditorState.rawToken,
					packageIds,
					packageKodyIds,
					exportNames,
					sources,
				}),
			})
			if (response.status === 401) {
				redirectToLogin()
				return
			}
			const payload = await readJson<
				AccountPackageInvocationTokensLoaderData & {
					error?: string
					ok?: boolean
				}
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to update token.')
			}
			mutationVersion += 1
			const detailHref = packageInvocationTokensRoute.buildDetailHref(
				tokenId,
				getCurrentSearch(),
			)
			applyPayload(payload, detailHref)
			saveState = 'idle'
			message = nextEditorState.rawToken
				? 'Saved token and replaced its raw value.'
				: 'Saved token.'
			messageTone = 'info'
			syncRouterLocation(detailHref)
			handle.update()
		} catch (error) {
			saveState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to update token.'
			messageTone = 'error'
			handle.update()
		}
	}

	async function revokeSelectedToken() {
		const tokenId = getCurrentSelectedTokenId()
		if (!tokenId || saveState !== 'idle') return
		saveState = 'revoking'
		message = null
		messageTone = 'info'
		handle.update()
		try {
			const response = await fetch(accountPackageInvocationTokensApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'revoke',
					id: tokenId,
				}),
			})
			if (response.status === 401) {
				redirectToLogin()
				return
			}
			const payload = await readJson<
				AccountPackageInvocationTokensLoaderData & {
					error?: string
					ok?: boolean
				}
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to revoke token.')
			}
			mutationVersion += 1
			const detailHref = packageInvocationTokensRoute.buildDetailHref(
				tokenId,
				getCurrentSearch(),
			)
			applyPayload({ ...payload, selectedTokenId: tokenId }, detailHref)
			saveState = 'idle'
			message = 'Revoked token.'
			messageTone = 'info'
			syncRouterLocation(detailHref)
			handle.update()
		} catch (error) {
			saveState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to revoke token.'
			messageTone = 'error'
			handle.update()
		}
	}

	async function reinstateSelectedToken() {
		const tokenId = getCurrentSelectedTokenId()
		if (!tokenId || saveState !== 'idle') return
		saveState = 'reinstating'
		message = null
		messageTone = 'info'
		handle.update()
		try {
			const response = await fetch(accountPackageInvocationTokensApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'reinstate',
					id: tokenId,
				}),
			})
			if (response.status === 401) {
				redirectToLogin()
				return
			}
			const payload = await readJson<
				AccountPackageInvocationTokensLoaderData & {
					error?: string
					ok?: boolean
				}
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to reinstate token.')
			}
			mutationVersion += 1
			const detailHref = packageInvocationTokensRoute.buildDetailHref(
				tokenId,
				getCurrentSearch(),
			)
			applyPayload(payload, detailHref)
			saveState = 'idle'
			message = 'Reinstated token.'
			messageTone = 'info'
			syncRouterLocation(detailHref)
			handle.update()
		} catch (error) {
			saveState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to reinstate token.'
			messageTone = 'error'
			handle.update()
		}
	}

	async function deleteSelectedToken() {
		const tokenId = getCurrentSelectedTokenId()
		if (!tokenId || saveState !== 'idle') return
		saveState = 'deleting'
		message = null
		messageTone = 'info'
		handle.update()
		try {
			const response = await fetch(accountPackageInvocationTokensApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'delete',
					id: tokenId,
				}),
			})
			if (response.status === 401) {
				redirectToLogin()
				return
			}
			const payload = await readJson<
				AccountPackageInvocationTokensLoaderData & {
					error?: string
					ok?: boolean
				}
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to delete token.')
			}
			mutationVersion += 1
			const listHref =
				packageInvocationTokensRoute.buildListHref(getCurrentSearch())
			applyPayload(payload, listHref)
			saveState = 'idle'
			selectedTokenId = null
			editorState = createEmptyEditorState()
			editMode = false
			message = 'Deleted token permanently.'
			messageTone = 'info'
			syncRouterLocation(listHref)
			handle.update()
		} catch (error) {
			saveState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to delete token.'
			messageTone = 'error'
			handle.update()
		}
	}

	/**
	 * Local cleanup when a sidebar link starts navigating to another token.
	 * Editor state is deliberately NOT seeded here: until the navigation
	 * commits, the URL (and therefore `getCurrentSelectedTokenId`) still
	 * points at the previous token, and a save during that window would write
	 * the new token's editor fields onto the old token. `applyPayload`
	 * initializes the editor from the committed payload instead.
	 */
	function resetTokenSelectionState() {
		revokeConfirm = false
		deleteTokenCheck.reset()
		message = null
		messageTone = 'info'
		handle.update()
	}

	function applyRouteLoaderData(href: string) {
		if (!packageInvocationTokensRoute.isRoutePath(href)) return false
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'accountPackageInvocationTokens',
			href,
		)
		if (!routeData) return false
		applyPayload(routeData, href)
		status = 'ready'
		message = null
		messageTone = 'info'
		loadLatch.markLoaded(getDataLatchKey(href))
		return true
	}

	return () => {
		const currentHref = getCurrentHref()
		const appliedRouteData = applyRouteLoaderData(currentHref)
		// A same-path refresh whose loader failed leaves no preload and no
		// href change; the stale marker forces the fallback refetch.
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const latchKey = getDataLatchKey(currentHref)
		const isRefreshingForLocationChange =
			status !== 'loading' && !loadLatch.isLoadedFor(latchKey)
		const needsLoad = loadLatch.needsLoad({
			currentHref: latchKey,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadTokens)
		}
		const isMutating = saveState !== 'idle'
		const selection = packageInvocationTokensRoute.getSelection(currentHref)
		const filters = readFilterState(currentHref)
		const filteredTokens = filterTokens(tokens, filters.search, packages)
		// The URL is the source of truth for selection in every environment:
		// the base tokens path (no token segment) means nothing is selected,
		// so falling back to module state here would keep a stale detail
		// panel open after navigating back to the list.
		const effectiveSelectedTokenId = selection.selectedId
		const selectedToken =
			tokens.find((token) => token.id === effectiveSelectedTokenId) ?? null
		const isEditingSelectedToken =
			editMode &&
			!isRefreshingForLocationChange &&
			selectedToken != null &&
			!selectedToken.revokedAt
		const showTokenNotFound =
			selection.selectedId != null &&
			!selectedToken &&
			!isRefreshingForLocationChange
		const showEmptySelection =
			!selection.isCreating && selection.selectedId == null
		const showSupportingSections =
			selection.isCreating || selection.selectedId != null
		const endpointTemplate = username
			? `${invocationUrlOrigin}/@${username}/api/package-invocations/<kodyId>/<exportName>`
			: ''

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Package tokens"
					description="Create bearer tokens for trusted personal clients without storing the raw token in Kody."
					currentHref={currentHref}
					actions={
						<button
							type="button"
							disabled={isMutating}
							mix={[on('click', startNewToken), css(primaryButtonCss)]}
						>
							New token
						</button>
					}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading package invocation tokens...
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' ? (
					<AccountManagementLayout
						sidebarWidth="minmax(18rem, 24rem)"
						sidebar={
							<AccountManagementSidebar
								title="Tokens"
								description="Revoked tokens remain listed for auditability and do not authorize external invocation requests."
							>
								<AccountManagementSearchField
									label="Search"
									placeholder="Search tokens"
									value={filters.search}
									onInput={(value) => {
										replaceLocation(buildHrefWithUpdatedSearch(value))
									}}
								/>
								{tokens.length === 0 ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No package invocation tokens yet.
									</p>
								) : filteredTokens.length === 0 ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No tokens match the current filters.
									</p>
								) : (
									<AccountManagementList>
										{filteredTokens.map((token) => {
											const isSelected = effectiveSelectedTokenId === token.id
											return (
												<li key={token.id} mix={css({ minWidth: 0 })}>
													<AccountManagementListItemLink
														href={packageInvocationTokensRoute.buildDetailHref(
															token.id,
															getCurrentSearch(),
														)}
														active={isSelected}
														disabled={isMutating}
														onNavigate={resetTokenSelectionState}
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
																{token.name}
															</strong>
															<span
																mix={css({
																	fontSize: typography.fontSize.xs,
																	color: colors.textMuted,
																})}
															>
																{formatTimestamp(token.createdAt)}
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
															{tokenStatus(token)}
															{' · '}
															{tokenPackageSummary(token)}
														</span>
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
															Exports: {formatScope(token.exportNames)}
														</span>
													</AccountManagementListItemLink>
												</li>
											)
										})}
									</AccountManagementList>
								)}
							</AccountManagementSidebar>
						}
					>
						<div mix={css({ display: 'grid', gap: spacing.lg })}>
							{selection.isCreating ? (
								<form
									method="post"
									noValidate
									{...passwordManagerIgnoreProps}
									mix={[
										on('submit', (event) => {
											event.preventDefault()
											if (event.currentTarget instanceof HTMLFormElement) {
												void createToken(event.currentTarget)
											}
										}),
										css(cardCss),
									]}
								>
									<div mix={css({ display: 'grid', gap: spacing.xs })}>
										<h2 mix={css(cardTitleCss)}>Create token</h2>
										<p mix={css(descriptionCss)}>
											Paste the raw token once. Kody stores only its hash, so
											keep the raw value in the trusted client.
										</p>
									</div>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Name</span>
										<input
											data-field-ring
											name="name"
											type="text"
											value={editorState.name}
											placeholder="Personal automation"
											disabled={isMutating}
											required
											mix={[
												on('input', (event) => {
													setEditorField('name', event.currentTarget.value)
													handle.update()
												}),
												css(accountInputCss),
											]}
										/>
									</label>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Raw token</span>
										<div
											mix={css({
												display: 'grid',
												gridTemplateColumns: 'minmax(0, 1fr) auto auto',
												gap: spacing.sm,
												[mq.mobile]: {
													gridTemplateColumns: '1fr',
												},
											})}
										>
											<input
												data-field-ring
												name="rawToken"
												type="password"
												value={editorState.rawToken}
												placeholder="Paste or generate a token"
												{...passwordManagerIgnoreProps}
												disabled={isMutating}
												required
												mix={[
													on('input', (event) => {
														setEditorField(
															'rawToken',
															event.currentTarget.value,
														)
														handle.update()
													}),
													css(accountInputCss),
												]}
											/>
											<button
												type="button"
												disabled={isMutating}
												mix={[
													on('click', generateEditorRawToken),
													css(secondaryButtonCss),
												]}
											>
												Generate
											</button>
											<button
												type="button"
												disabled={isMutating || !editorState.rawToken}
												mix={[
													on('click', () => void copyEditorRawToken()),
													css(secondaryButtonCss),
												]}
											>
												Copy
											</button>
										</div>
										<span mix={css(descriptionCss)}>
											Use Generate when the exact bearer value does not matter.
											Copy or deliver this exact raw value to the external
											service or secret before saving.
										</span>
									</label>

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
											<span mix={css(fieldLabelCss)}>Package Kody IDs</span>
											<textarea
												data-field-ring
												name="packageKodyIds"
												value={editorState.packageKodyIdsText}
												placeholder={'discord-gateway\n*'}
												disabled={isMutating}
												mix={[
													on('input', (event) => {
														setEditorField(
															'packageKodyIdsText',
															event.currentTarget.value,
														)
														handle.update()
													}),
													css(accountTextareaCss),
												]}
											/>
										</label>
										<label mix={css(fieldCss)}>
											<span mix={css(fieldLabelCss)}>Package IDs</span>
											<textarea
												data-field-ring
												name="packageIds"
												value={editorState.packageIdsText}
												placeholder="pkg_..."
												disabled={isMutating}
												mix={[
													on('input', (event) => {
														setEditorField(
															'packageIdsText',
															event.currentTarget.value,
														)
														handle.update()
													}),
													css(accountTextareaCss),
												]}
											/>
										</label>
									</div>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Export names</span>
										<textarea
											data-field-ring
											name="exportNames"
											value={editorState.exportNamesText}
											placeholder={'dispatch-message-created\n*'}
											disabled={isMutating}
											required
											mix={[
												on('input', (event) => {
													setEditorField(
														'exportNamesText',
														event.currentTarget.value,
													)
													handle.update()
												}),
												css(accountTextareaCss),
											]}
										/>
									</label>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Allowed sources</span>
										<textarea
											data-field-ring
											name="sources"
											value={editorState.sourcesText}
											placeholder="personal-client"
											disabled={isMutating}
											mix={[
												on('input', (event) => {
													setEditorField(
														'sourcesText',
														event.currentTarget.value,
													)
													handle.update()
												}),
												css(accountTextareaCss),
											]}
										/>
										<span mix={css(descriptionCss)}>
											Leave blank to allow requests that omit source. If a
											request supplies source, it must be listed here exactly.
										</span>
									</label>

									<div
										mix={css({
											display: 'flex',
											gap: spacing.sm,
											flexWrap: 'wrap',
										})}
									>
										<button
											type="submit"
											disabled={isMutating}
											mix={css(primaryButtonCss)}
										>
											{saveState === 'creating'
												? 'Creating...'
												: 'Create token'}
										</button>
									</div>
								</form>
							) : null}

							{showEmptySelection ? (
								<div mix={css({ ...cardCss, gap: spacing.sm })}>
									<h2
										mix={css({
											margin: 0,
											fontSize: typography.fontSize.lg,
											fontWeight: typography.fontWeight.semibold,
											color: colors.text,
										})}
									>
										Select a token
									</h2>
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										Pick a token from the list to view or edit it, or create a
										new one.
									</p>
								</div>
							) : null}

							{isEditingSelectedToken ? (
								<form
									method="post"
									noValidate
									{...passwordManagerIgnoreProps}
									mix={[
										on('submit', (event) => {
											event.preventDefault()
											if (event.currentTarget instanceof HTMLFormElement) {
												void updateSelectedToken(event.currentTarget)
											}
										}),
										css(cardCss),
									]}
								>
									<div mix={css({ display: 'grid', gap: spacing.xs })}>
										<h2 mix={css(cardTitleCss)}>Edit token</h2>
										<p mix={css(descriptionCss)}>
											Update this token's display name, bearer value, and
											allowed scopes. The current raw token and stored hash are
											never shown.
										</p>
										<span mix={css(tokenStatusCss(selectedToken))}>
											{tokenStatus(selectedToken)}
										</span>
									</div>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Name</span>
										<input
											data-field-ring
											name="name"
											type="text"
											value={editorState.name}
											placeholder="Personal automation"
											disabled={isMutating}
											required
											mix={[
												on('input', (event) => {
													setEditorField('name', event.currentTarget.value)
													handle.update()
												}),
												css(accountInputCss),
											]}
										/>
									</label>

									<div
										mix={css({
											display: 'grid',
											gap: spacing.sm,
											padding: spacing.md,
											borderRadius: radius.md,
											border: `1px solid ${colors.border}`,
											backgroundColor: colors.background,
										})}
									>
										<div mix={css({ display: 'grid', gap: spacing.xs })}>
											<span mix={css(fieldLabelCss)}>Token value</span>
											<p mix={css(descriptionCss)}>
												The current token value is hidden and cannot be
												recovered. To edit it, enter or generate a new raw token
												value here, then save.
											</p>
										</div>
										<label mix={css(fieldCss)}>
											<span mix={css(fieldLabelCss)}>New raw token value</span>
											<div
												mix={css({
													display: 'grid',
													gridTemplateColumns: 'minmax(0, 1fr) auto auto',
													gap: spacing.sm,
													[mq.mobile]: {
														gridTemplateColumns: '1fr',
													},
												})}
											>
												<input
													data-field-ring
													name="rawToken"
													type="password"
													value={editorState.rawToken}
													placeholder="Leave blank to keep the current token value"
													{...passwordManagerIgnoreProps}
													disabled={isMutating}
													mix={[
														on('input', (event) => {
															setEditorField(
																'rawToken',
																event.currentTarget.value,
															)
															handle.update()
														}),
														css(accountInputCss),
													]}
												/>
												<button
													type="button"
													disabled={isMutating}
													mix={[
														on('click', generateEditorRawToken),
														css(secondaryButtonCss),
													]}
												>
													Generate
												</button>
												<button
													type="button"
													disabled={isMutating || !editorState.rawToken}
													mix={[
														on('click', () => void copyEditorRawToken()),
														css(secondaryButtonCss),
													]}
												>
													Copy
												</button>
											</div>
											<span mix={css(descriptionCss)}>
												Leave this blank to keep the current token value. Kody
												stores only the hash of any new value, so copy or
												deliver the exact replacement before saving.
											</span>
										</label>
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
											<span mix={css(fieldLabelCss)}>Package Kody IDs</span>
											<textarea
												data-field-ring
												name="packageKodyIds"
												value={editorState.packageKodyIdsText}
												placeholder={'discord-gateway\n*'}
												disabled={isMutating}
												mix={[
													on('input', (event) => {
														setEditorField(
															'packageKodyIdsText',
															event.currentTarget.value,
														)
														handle.update()
													}),
													css(accountTextareaCss),
												]}
											/>
										</label>
										<label mix={css(fieldCss)}>
											<span mix={css(fieldLabelCss)}>Package IDs</span>
											<textarea
												data-field-ring
												name="packageIds"
												value={editorState.packageIdsText}
												placeholder="pkg_..."
												disabled={isMutating}
												mix={[
													on('input', (event) => {
														setEditorField(
															'packageIdsText',
															event.currentTarget.value,
														)
														handle.update()
													}),
													css(accountTextareaCss),
												]}
											/>
										</label>
									</div>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Export names</span>
										<textarea
											data-field-ring
											name="exportNames"
											value={editorState.exportNamesText}
											placeholder={'dispatch-message-created\n*'}
											disabled={isMutating}
											required
											mix={[
												on('input', (event) => {
													setEditorField(
														'exportNamesText',
														event.currentTarget.value,
													)
													handle.update()
												}),
												css(accountTextareaCss),
											]}
										/>
									</label>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Allowed sources</span>
										<textarea
											data-field-ring
											name="sources"
											value={editorState.sourcesText}
											placeholder="personal-client"
											disabled={isMutating}
											mix={[
												on('input', (event) => {
													setEditorField(
														'sourcesText',
														event.currentTarget.value,
													)
													handle.update()
												}),
												css(accountTextareaCss),
											]}
										/>
										<span mix={css(descriptionCss)}>
											Leave blank to allow requests that omit source. If a
											request supplies source, it must be listed here exactly.
										</span>
									</label>

									<div
										mix={css({
											display: 'flex',
											gap: spacing.sm,
											flexWrap: 'wrap',
										})}
									>
										<button
											type="submit"
											disabled={isMutating}
											mix={css(primaryButtonCss)}
										>
											{saveState === 'updating' ? 'Saving...' : 'Save token'}
										</button>
										<button
											type="button"
											disabled={isMutating}
											mix={[
												on('click', cancelEditToken),
												css(secondaryButtonCss),
											]}
										>
											Cancel
										</button>
										<button
											type="button"
											disabled={isMutating}
											mix={[
												on('click', () => {
													if (!revokeConfirm) {
														revokeConfirm = true
														deleteTokenCheck.reset()
														handle.update()
														return
													}
													void revokeSelectedToken()
												}),
												css(dangerButtonCss),
											]}
										>
											{saveState === 'revoking'
												? 'Revoking...'
												: revokeConfirm
													? 'Confirm revoke'
													: 'Revoke token'}
										</button>
										<button
											type="button"
											disabled={isMutating}
											mix={[
												...deleteTokenCheck.getButtonMix({
													onFirstClick: () => {
														revokeConfirm = false
													},
													on: {
														click: () => void deleteSelectedToken(),
													},
												}),
												css(dangerButtonCss),
											]}
										>
											{saveState === 'deleting'
												? 'Deleting...'
												: deleteTokenCheck.doubleCheck
													? 'Confirm permanent delete'
													: 'Delete permanently'}
										</button>
									</div>
								</form>
							) : null}

							{showSupportingSections ? (
								<section mix={css(cardCss)}>
									<h2 mix={css(cardTitleCss)}>Invocation endpoint</h2>
									<p mix={css(descriptionCss)}>
										External clients call this endpoint with the raw token in
										the Authorization header.
									</p>
									<code
										mix={css({
											display: 'block',
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
										{endpointTemplate}
									</code>
								</section>
							) : null}

							{selectedToken && !isEditingSelectedToken ? (
								<section mix={css(cardCss)}>
									<div mix={css({ display: 'grid', gap: spacing.xs })}>
										<h2 mix={css(cardTitleCss)}>{selectedToken.name}</h2>
										<span mix={css(tokenStatusCss(selectedToken))}>
											{tokenStatus(selectedToken)}
										</span>
										<p mix={css(descriptionCss)}>
											Token material is hidden permanently. This view only shows
											metadata and policy scopes.
										</p>
									</div>
									<MetadataGrid
										items={[
											{
												label: 'Package Kody IDs',
												value: formatScope(selectedToken.packageKodyIds),
											},
											{
												label: 'Package IDs',
												value: formatScope(selectedToken.packageIds),
											},
											{
												label: 'Exports',
												value: formatScope(selectedToken.exportNames),
											},
											{
												label: 'Sources',
												value: formatScope(selectedToken.sources),
											},
											{
												label: 'Last used',
												value: formatNullableTimestamp(
													selectedToken.lastUsedAt,
												),
											},
											{
												label: 'Created',
												value: formatNullableTimestamp(selectedToken.createdAt),
											},
											{
												label: 'Updated',
												value: formatNullableTimestamp(selectedToken.updatedAt),
											},
											{
												label: 'Revoked',
												value: formatNullableTimestamp(selectedToken.revokedAt),
											},
										]}
									/>
									<div
										mix={css({
											display: 'flex',
											gap: spacing.sm,
											flexWrap: 'wrap',
										})}
									>
										{selectedToken.revokedAt ? (
											<button
												type="button"
												disabled={isMutating}
												mix={[
													on('click', () => {
														void reinstateSelectedToken()
													}),
													css(secondaryButtonCss),
												]}
											>
												{saveState === 'reinstating'
													? 'Reinstating...'
													: 'Reinstate token'}
											</button>
										) : (
											<>
												<button
													type="button"
													disabled={isMutating}
													mix={[
														on('click', () => startEditToken(selectedToken)),
														css(secondaryButtonCss),
													]}
												>
													Edit token
												</button>
												<button
													type="button"
													disabled={isMutating}
													mix={[
														on('click', () => {
															if (!revokeConfirm) {
																revokeConfirm = true
																deleteTokenCheck.reset()
																handle.update()
																return
															}
															void revokeSelectedToken()
														}),
														css(dangerButtonCss),
													]}
												>
													{saveState === 'revoking'
														? 'Revoking...'
														: revokeConfirm
															? 'Confirm revoke'
															: 'Revoke token'}
												</button>
											</>
										)}
										<button
											type="button"
											disabled={isMutating}
											mix={[
												...deleteTokenCheck.getButtonMix({
													onFirstClick: () => {
														revokeConfirm = false
													},
													on: {
														click: () => void deleteSelectedToken(),
													},
												}),
												css(dangerButtonCss),
											]}
										>
											{saveState === 'deleting'
												? 'Deleting...'
												: deleteTokenCheck.doubleCheck
													? 'Confirm permanent delete'
													: 'Delete permanently'}
										</button>
									</div>
								</section>
							) : null}

							{showTokenNotFound ? (
								<section mix={css(cardCss)}>
									<h2 mix={css(cardTitleCss)}>Token not found</h2>
									<p mix={css(descriptionCss)}>
										This package invocation token does not exist for this
										account or is unavailable.
									</p>
									<button
										type="button"
										disabled={isMutating}
										mix={[
											on('click', () => {
												selectedTokenId = null
												editorState = createEmptyEditorState()
												editMode = false
												syncRouterLocation(
													packageInvocationTokensRoute.buildListHref(
														getCurrentSearch(),
													),
												)
												handle.update()
											}),
											css(secondaryButtonCss),
										]}
									>
										Back to tokens
									</button>
								</section>
							) : null}

							{showSupportingSections ? (
								<section mix={css(cardCss)}>
									<h2 mix={css(cardTitleCss)}>Owned packages</h2>
									<p mix={css(descriptionCss)}>
										Concrete package scopes must refer to packages owned by this
										account. Use <code>*</code> only for trusted personal
										clients.
									</p>
									{packages.length === 0 ? (
										<p mix={css({ margin: 0, color: colors.textMuted })}>
											No saved packages yet.
										</p>
									) : (
										<ul
											mix={css({
												margin: 0,
												paddingLeft: spacing.lg,
												color: colors.text,
											})}
										>
											{packages.map((savedPackage) => (
												<li key={savedPackage.id}>
													<strong>{savedPackage.kodyId}</strong> -{' '}
													{savedPackage.name}
												</li>
											))}
										</ul>
									)}
								</section>
							) : null}
						</div>
					</AccountManagementLayout>
				) : null}
			</AccountManagementShell>
		)
	}
}
