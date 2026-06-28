import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
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
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
	textareaCss,
} from '#client/styles/style-primitives.ts'
import {
	AccountManagementHeader,
	AccountManagementLayout,
	AccountManagementList,
	AccountManagementListItemButton,
	AccountManagementMessage,
	AccountManagementShell,
	AccountManagementSidebar,
	MetadataGrid,
} from './account-management-components.tsx'

type PackageOption = {
	id: string
	kodyId: string
	name: string
}

type PackageInvocationTokenListItem = {
	id: string
	name: string
	packageIds: Array<string>
	packageKodyIds: Array<string>
	exportNames: Array<string>
	sources: Array<string>
	createdAt: string
	updatedAt: string
	lastUsedAt: string | null
	revokedAt: string | null
}

type AccountPackageInvocationTokensPayload = {
	ok: true
	email: string
	username: string
	invocationUrlOrigin: string
	packages: Array<PackageOption>
	tokens: Array<PackageInvocationTokenListItem>
	selectedTokenId?: string
}

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
const wildcardScope = '*'

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

function formatTimestamp(value: string | null) {
	return value ? new Date(value).toLocaleString() : 'Never'
}

function readTrimmedParam(params: URLSearchParams, key: string) {
	const value = params.get(key)
	return value?.trim() ? value.trim() : null
}

function readCommaListParams(params: URLSearchParams, keys: Array<string>) {
	return keys.flatMap((key) =>
		params
			.getAll(key)
			.flatMap((value) => value.split(','))
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0),
	)
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

function isNewTokenPath(href: string) {
	const url = new URL(href, 'http://localhost')
	return url.pathname === `${accountPackageInvocationTokensBasePath}/new`
}

function getSelectedTokenIdFromPath(href: string) {
	const url = new URL(href, 'http://localhost')
	const detailPrefix = `${accountPackageInvocationTokensBasePath}/`
	if (
		url.pathname === `${accountPackageInvocationTokensBasePath}/new` ||
		!url.pathname.startsWith(detailPrefix)
	) {
		return null
	}
	const tokenId = decodeURIComponent(url.pathname.slice(detailPrefix.length))
	return tokenId || null
}

function buildTokenDetailPath(tokenId: string) {
	return `${accountPackageInvocationTokensBasePath}/${encodeURIComponent(tokenId)}`
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

function encodeBase64Url(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '')
}

function generatePackageInvocationRawToken() {
	const cryptoApi = globalThis.crypto
	if (!cryptoApi?.getRandomValues) {
		throw new Error('This browser cannot generate secure random tokens.')
	}
	const bytes = new Uint8Array(32)
	cryptoApi.getRandomValues(bytes)
	return `kody_${encodeBase64Url(bytes)}`
}

function formatScope(values: Array<string>) {
	if (values.length === 0) return 'None'
	if (values.includes(wildcardScope)) return 'Any'
	return values.join(', ')
}

function tokenStatus(token: PackageInvocationTokenListItem) {
	return token.revokedAt ? 'Revoked' : 'Active'
}

function tokenStatusCss(token: PackageInvocationTokenListItem) {
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
	token: PackageInvocationTokenListItem,
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
	let email = ''
	let username = ''
	let invocationUrlOrigin = ''
	let packages: Array<PackageOption> = []
	let tokens: Array<PackageInvocationTokenListItem> = []
	let editorState = createEmptyEditorState()
	let selectedTokenId: string | null = null
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let lastLoadedHref = ''
	let lastNewTokenQueryKey = ''
	let mutationVersion = 0
	let revokeConfirm = false
	let deleteConfirm = false
	let editMode = false

	const primaryButtonCss = getPrimaryButtonCss()
	const dangerButtonCss = getDangerButtonCss()
	const secondaryButtonCss = getSecondaryButtonCss()

	function redirectToLogin() {
		saveState = 'idle'
		status = 'ready'
		if (typeof window !== 'undefined') {
			window.location.assign('/login')
		}
	}

	function getCurrentSelectedTokenId() {
		const href =
			typeof window === 'undefined'
				? accountPackageInvocationTokensBasePath
				: window.location.href
		return getSelectedTokenIdFromPath(href) ?? selectedTokenId
	}

	async function loadTokens(signal: AbortSignal) {
		const loadStartedAtMutationVersion = mutationVersion
		try {
			const href =
				typeof window === 'undefined'
					? accountPackageInvocationTokensBasePath
					: window.location.href
			lastLoadedHref = href
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
				await readJson<AccountPackageInvocationTokensPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load package invocation tokens.')
			}
			if (loadStartedAtMutationVersion !== mutationVersion) return
			const latestHref =
				typeof window === 'undefined'
					? accountPackageInvocationTokensBasePath
					: window.location.href
			if (href !== latestHref) return
			applyPayload(payload, latestHref)
			status = 'ready'
			message = null
			messageTone = 'info'
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
			handle.update()
		}
	}

	function applyPayload(
		payload: AccountPackageInvocationTokensPayload,
		href: string,
	) {
		email = payload.email
		username = payload.username
		invocationUrlOrigin = payload.invocationUrlOrigin
		packages = payload.packages
		tokens = payload.tokens
		revokeConfirm = false
		deleteConfirm = false
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
		if (isNewTokenPath(href)) {
			const queryKey = getNewTokenQueryKey(href)
			if (queryKey !== lastNewTokenQueryKey) {
				lastNewTokenQueryKey = queryKey
				editorState = createEditorStateFromNewTokenQuery(href)
				selectedTokenId = null
				editMode = false
			}
			return
		}
		const pathSelectedTokenId = getSelectedTokenIdFromPath(href)
		if (pathSelectedTokenId) {
			selectedTokenId = pathSelectedTokenId
			const selectedToken = tokens.find(
				(token) => token.id === pathSelectedTokenId,
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
			await navigator.clipboard.writeText(editorState.rawToken)
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
		deleteConfirm = false
		editMode = false
		message = null
		messageTone = 'info'
		if (typeof window !== 'undefined') {
			window.history.pushState(
				null,
				'',
				`${accountPackageInvocationTokensBasePath}/new`,
			)
			lastLoadedHref = window.location.href
			lastNewTokenQueryKey = getNewTokenQueryKey(window.location.href)
		}
		handle.update()
	}

	function startEditToken(token: PackageInvocationTokenListItem) {
		if (token.revokedAt) return
		editorState = createEditorStateFromToken(token)
		selectedTokenId = token.id
		editMode = true
		revokeConfirm = false
		deleteConfirm = false
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
		deleteConfirm = false
		message = null
		messageTone = 'info'
		if (typeof window !== 'undefined') {
			window.history.pushState(
				null,
				'',
				tokenId
					? buildTokenDetailPath(tokenId)
					: accountPackageInvocationTokensBasePath,
			)
			lastLoadedHref = window.location.href
		}
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
				AccountPackageInvocationTokensPayload & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to create token.')
			}
			mutationVersion += 1
			applyPayload(payload, accountPackageInvocationTokensBasePath)
			saveState = 'idle'
			message =
				'Created token. The raw token was not stored and will not be shown again.'
			messageTone = 'info'
			if (typeof window !== 'undefined') {
				const nextPath = payload.selectedTokenId
					? buildTokenDetailPath(payload.selectedTokenId)
					: accountPackageInvocationTokensBasePath
				window.history.pushState(null, '', nextPath)
				lastLoadedHref = window.location.href
			}
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
				AccountPackageInvocationTokensPayload & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to update token.')
			}
			mutationVersion += 1
			applyPayload(payload, buildTokenDetailPath(tokenId))
			saveState = 'idle'
			message = nextEditorState.rawToken
				? 'Saved token and replaced its raw value.'
				: 'Saved token.'
			messageTone = 'info'
			if (typeof window !== 'undefined') {
				window.history.pushState(null, '', buildTokenDetailPath(tokenId))
				lastLoadedHref = window.location.href
			}
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
				AccountPackageInvocationTokensPayload & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to revoke token.')
			}
			mutationVersion += 1
			applyPayload(
				{ ...payload, selectedTokenId: tokenId },
				buildTokenDetailPath(tokenId),
			)
			saveState = 'idle'
			message = 'Revoked token.'
			messageTone = 'info'
			if (typeof window !== 'undefined') {
				window.history.pushState(null, '', buildTokenDetailPath(tokenId))
				lastLoadedHref = window.location.href
			}
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
				AccountPackageInvocationTokensPayload & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to reinstate token.')
			}
			mutationVersion += 1
			applyPayload(payload, buildTokenDetailPath(tokenId))
			saveState = 'idle'
			message = 'Reinstated token.'
			messageTone = 'info'
			if (typeof window !== 'undefined') {
				window.history.pushState(null, '', buildTokenDetailPath(tokenId))
				lastLoadedHref = window.location.href
			}
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
				AccountPackageInvocationTokensPayload & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to delete token.')
			}
			mutationVersion += 1
			applyPayload(payload, accountPackageInvocationTokensBasePath)
			saveState = 'idle'
			selectedTokenId = null
			editorState = createEmptyEditorState()
			editMode = false
			message = 'Deleted token permanently.'
			messageTone = 'info'
			if (typeof window !== 'undefined') {
				window.history.pushState(
					null,
					'',
					accountPackageInvocationTokensBasePath,
				)
				lastLoadedHref = window.location.href
			}
			handle.update()
		} catch (error) {
			saveState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to delete token.'
			messageTone = 'error'
			handle.update()
		}
	}

	function selectToken(token: PackageInvocationTokenListItem) {
		selectedTokenId = token.id
		editorState = token.revokedAt
			? createEmptyEditorState()
			: createEditorStateFromToken(token)
		lastNewTokenQueryKey = ''
		revokeConfirm = false
		deleteConfirm = false
		editMode = !token.revokedAt
		message = null
		messageTone = 'info'
		if (typeof window !== 'undefined') {
			window.history.pushState(null, '', buildTokenDetailPath(token.id))
			lastLoadedHref = window.location.href
		}
		handle.update()
	}

	return () => {
		const currentHref =
			typeof window === 'undefined'
				? accountPackageInvocationTokensBasePath
				: window.location.href
		const isRefreshingForLocationChange =
			status !== 'loading' && currentHref !== lastLoadedHref
		if (status === 'loading' || isRefreshingForLocationChange) {
			handle.queueTask(loadTokens)
		}
		const isMutating = saveState !== 'idle'
		const isCreatingToken = isNewTokenPath(currentHref)
		const requestedTokenId = getSelectedTokenIdFromPath(currentHref)
		const effectiveSelectedTokenId =
			typeof window === 'undefined' ? selectedTokenId : requestedTokenId
		const selectedToken =
			tokens.find((token) => token.id === effectiveSelectedTokenId) ?? null
		const isEditingSelectedToken =
			editMode &&
			!isRefreshingForLocationChange &&
			selectedToken != null &&
			!selectedToken.revokedAt
		const showTokenNotFound =
			requestedTokenId != null &&
			!selectedToken &&
			!isRefreshingForLocationChange
		const endpointTemplate = username
			? `${invocationUrlOrigin}/@${username}/api/package-invocations/<kodyId>/<exportName>`
			: ''

		return (
			<AccountManagementShell maxWidth="76rem">
				<AccountManagementHeader
					title={
						email
							? `${email} package invocation tokens`
							: 'Package invocation tokens'
					}
					description="Create bearer tokens for trusted personal clients without storing the raw token in Kody."
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
								{tokens.length === 0 ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No package invocation tokens yet.
									</p>
								) : (
									<AccountManagementList>
										{tokens.map((token) => {
											const isSelected = effectiveSelectedTokenId === token.id
											return (
												<li key={token.id}>
													<AccountManagementListItemButton
														active={isSelected}
														disabled={isMutating}
														onClick={() => {
															if (isMutating) return
															selectToken(token)
														}}
													>
														<strong>{token.name}</strong>
														<span mix={css(tokenStatusCss(token))}>
															{tokenStatus(token)}
														</span>
														<span
															mix={css({
																color: colors.textMuted,
																fontSize: typography.fontSize.sm,
															})}
														>
															Exports: {formatScope(token.exportNames)}
														</span>
													</AccountManagementListItemButton>
												</li>
											)
										})}
									</AccountManagementList>
								)}
							</AccountManagementSidebar>
						}
					>
						<div mix={css({ display: 'grid', gap: spacing.lg })}>
							{isCreatingToken || (!requestedTokenId && !selectedToken) ? (
								<form
									method="post"
									noValidate
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
												css(inputCss),
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
												name="rawToken"
												type="password"
												value={editorState.rawToken}
												placeholder="Paste or generate a token"
												autoComplete="off"
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
													css(inputCss),
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
													css(textareaCss),
												]}
											/>
										</label>
										<label mix={css(fieldCss)}>
											<span mix={css(fieldLabelCss)}>Package IDs</span>
											<textarea
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
													css(textareaCss),
												]}
											/>
										</label>
									</div>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Export names</span>
										<textarea
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
												css(textareaCss),
											]}
										/>
									</label>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Allowed sources</span>
										<textarea
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
												css(textareaCss),
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

							{isEditingSelectedToken ? (
								<form
									method="post"
									noValidate
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
												css(inputCss),
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
													name="rawToken"
													type="password"
													value={editorState.rawToken}
													placeholder="Leave blank to keep the current token value"
													autoComplete="off"
													disabled={isMutating}
													mix={[
														on('input', (event) => {
															setEditorField(
																'rawToken',
																event.currentTarget.value,
															)
															handle.update()
														}),
														css(inputCss),
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
													css(textareaCss),
												]}
											/>
										</label>
										<label mix={css(fieldCss)}>
											<span mix={css(fieldLabelCss)}>Package IDs</span>
											<textarea
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
													css(textareaCss),
												]}
											/>
										</label>
									</div>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Export names</span>
										<textarea
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
												css(textareaCss),
											]}
										/>
									</label>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Allowed sources</span>
										<textarea
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
												css(textareaCss),
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
														deleteConfirm = false
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
												on('click', () => {
													if (!deleteConfirm) {
														deleteConfirm = true
														revokeConfirm = false
														handle.update()
														return
													}
													void deleteSelectedToken()
												}),
												css(dangerButtonCss),
											]}
										>
											{saveState === 'deleting'
												? 'Deleting...'
												: deleteConfirm
													? 'Confirm permanent delete'
													: 'Delete permanently'}
										</button>
									</div>
								</form>
							) : null}

							<section mix={css(cardCss)}>
								<h2 mix={css(cardTitleCss)}>Invocation endpoint</h2>
								<p mix={css(descriptionCss)}>
									External clients call this endpoint with the raw token in the
									Authorization header.
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
												value: formatTimestamp(selectedToken.lastUsedAt),
											},
											{
												label: 'Created',
												value: formatTimestamp(selectedToken.createdAt),
											},
											{
												label: 'Updated',
												value: formatTimestamp(selectedToken.updatedAt),
											},
											{
												label: 'Revoked',
												value: formatTimestamp(selectedToken.revokedAt),
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
																deleteConfirm = false
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
												on('click', () => {
													if (!deleteConfirm) {
														deleteConfirm = true
														revokeConfirm = false
														handle.update()
														return
													}
													void deleteSelectedToken()
												}),
												css(dangerButtonCss),
											]}
										>
											{saveState === 'deleting'
												? 'Deleting...'
												: deleteConfirm
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
												if (typeof window !== 'undefined') {
													window.history.pushState(
														null,
														'',
														accountPackageInvocationTokensBasePath,
													)
													lastLoadedHref = window.location.href
												}
												handle.update()
											}),
											css(secondaryButtonCss),
										]}
									>
										Back to tokens
									</button>
								</section>
							) : null}

							<section mix={css(cardCss)}>
								<h2 mix={css(cardTitleCss)}>Owned packages</h2>
								<p mix={css(descriptionCss)}>
									Concrete package scopes must refer to packages owned by this
									account. Use <code>*</code> only for trusted personal clients.
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
						</div>
					</AccountManagementLayout>
				) : null}
			</AccountManagementShell>
		)
	}
}
