import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getValue, listValues } from '#mcp/values/service.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

const accountValuesBasePath = '/account/values'
const valuePreviewMaxLength = 80
const reservedValuePrefixes = ['_integration:', '_openapi:'] as const

export type AccountValueListItem = {
	id: string
	name: string
	description: string
	valuePreview: string
	updatedAt: string
	ttlMs: number | null
}

export type AccountValueDetail = {
	id: string
	name: string
	description: string
	value: string
	createdAt: string
	updatedAt: string
	ttlMs: number | null
	scope: 'user'
}

export type AccountValuesLoaderData = {
	ok: true
	values: Array<AccountValueListItem>
	selectedValue: AccountValueDetail | null
	selectedValueId: string | null
}

export function isReservedAccountValueName(name: string) {
	return reservedValuePrefixes.some((prefix) => name.startsWith(prefix))
}

export function truncateValuePreview(
	value: string,
	maxLength = valuePreviewMaxLength,
) {
	if (value.length <= maxLength) return value
	return `${value.slice(0, maxLength)}…`
}

/**
 * Detail ids are the raw value name. Path segments and JSON `selected` params
 * use encodeURIComponent / decodeURIComponent.
 */
export function valueNameToId(name: string) {
	return name
}

export function readAccountValuesSelectedValueId(
	requestUrl: string,
	selectedValueId?: string | null,
) {
	if (selectedValueId !== undefined) {
		return selectedValueId?.trim() ? selectedValueId.trim() : null
	}
	const url = new URL(requestUrl, 'http://localhost')
	const fromPath = readSelectedValueIdFromPath(url.pathname)
	if (fromPath) return fromPath
	const fromQuery = url.searchParams.get('selected')?.trim()
	return fromQuery ? fromQuery : null
}

function readSelectedValueIdFromPath(pathname: string) {
	if (pathname === `${accountValuesBasePath}/new`) return null
	const detailPrefix = `${accountValuesBasePath}/`
	if (!pathname.startsWith(detailPrefix)) return null
	const segment = pathname.slice(detailPrefix.length)
	if (!segment || segment.includes('/')) return null
	try {
		const decoded = decodeURIComponent(segment).trim()
		return decoded || null
	} catch {
		return segment.trim() || null
	}
}

function toListItem(metadata: ValueMetadata): AccountValueListItem {
	const id = valueNameToId(metadata.name)
	return {
		id,
		name: metadata.name,
		description: metadata.description,
		valuePreview: truncateValuePreview(metadata.value),
		updatedAt: metadata.updatedAt,
		ttlMs: metadata.ttlMs,
	}
}

function toDetail(metadata: ValueMetadata): AccountValueDetail {
	return {
		id: valueNameToId(metadata.name),
		name: metadata.name,
		description: metadata.description,
		value: metadata.value,
		createdAt: metadata.createdAt,
		updatedAt: metadata.updatedAt,
		ttlMs: metadata.ttlMs,
		scope: 'user',
	}
}

const userScopedStorageContext = {
	sessionId: null,
	appId: null,
} as const

export async function loadAccountValuesData(input: {
	env: Env
	user: AuthenticatedUser
	url?: string
	selectedValueId?: string | null
}): Promise<AccountValuesLoaderData> {
	const userId = input.user.mcpUser.userId
	const selectedValueId = input.url
		? readAccountValuesSelectedValueId(input.url, input.selectedValueId)
		: input.selectedValueId === undefined
			? null
			: input.selectedValueId?.trim()
				? input.selectedValueId.trim()
				: null

	const listed = await listValues({
		env: input.env,
		userId,
		scope: 'user',
		storageContext: userScopedStorageContext,
	})
	const visible = listed.filter(
		(entry) => !isReservedAccountValueName(entry.name),
	)
	const values = visible.map(toListItem)

	let selectedValue: AccountValueDetail | null = null
	if (selectedValueId && !isReservedAccountValueName(selectedValueId)) {
		const fromList = visible.find((entry) => entry.name === selectedValueId)
		if (fromList) {
			selectedValue = toDetail(fromList)
		} else {
			const fetched = await getValue({
				env: input.env,
				userId,
				name: selectedValueId,
				scope: 'user',
				storageContext: userScopedStorageContext,
			})
			if (fetched && fetched.scope === 'user') {
				selectedValue = toDetail(fetched)
			}
		}
	}

	const resolvedSelectedId =
		selectedValue?.id ??
		(selectedValueId && !isReservedAccountValueName(selectedValueId)
			? selectedValueId
			: null)

	return {
		ok: true,
		values,
		selectedValue,
		selectedValueId: resolvedSelectedId,
	}
}

export { userScopedStorageContext, accountValuesBasePath }
