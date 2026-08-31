import { type Handle } from 'remix/ui'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { recordCellClamp } from '#client/routes/record-table.tsx'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	type AccountEmailLoaderData,
	type AccountEmailMessageListItem,
} from '#universal/loader-data.ts'

export type PageStatus = 'loading' | 'ready' | 'error'
export type ClassifyState = 'idle' | 'saving'
export type ClassificationFilter = 'all' | 'quarantined'

export const accountEmailApiPath = '/account/email.json'
export const emailRoute = createListDetailRoute('/account/email')

export const quarantinedBadgeCss = {
	display: 'inline-flex',
	alignItems: 'center',
	padding: `0.2rem ${spacing.sm}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.danger}`,
	backgroundColor:
		'color-mix(in srgb, var(--color-danger) 10%, var(--color-surface))',
	color: colors.danger,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
} as const

export const truncatedTextCss = {
	minWidth: 0,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
} as const

/**
 * Subjects and addresses are arbitrary length, and a table cell will not
 * shrink below its content, so the clamp lives on a block inside the cell.
 * The subject also carries the quarantine badge: it is the one column that
 * never drops and the one that becomes the card heading, so a warning put
 * anywhere else can vanish at exactly the width where it matters most.
 */
export const subjectCellCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.xs,
	// `min()` for the same reason as `recordCellClamp`: below 620px this sits
	// in a card that can be narrower than the clamp.
	maxWidth: 'min(34ch, 100%)',
	minWidth: 0,
} as const

export const clampedCellCss = recordCellClamp(26)

export function readSearchQuery(href: string) {
	return new URL(href, 'http://localhost').searchParams.get('q')?.trim() ?? ''
}

export function readPage(href: string) {
	const raw = new URL(href, 'http://localhost').searchParams.get('page')
	const parsed = raw ? Number.parseInt(raw, 10) : 1
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

export function readClassificationFilter(href: string): ClassificationFilter {
	const raw = new URL(href, 'http://localhost').searchParams
		.get('classification')
		?.trim()
	return raw === 'quarantined' ? 'quarantined' : 'all'
}

/**
 * List window depends on search + page; selection also needs a server fetch
 * for message bodies, so the data key includes the selected message id.
 */
export function getDataKey(href: string) {
	const url = new URL(href, 'http://localhost')
	const selectedId = emailRoute.getSelection(href).selectedId ?? ''
	return `${url.pathname}?q=${readSearchQuery(href)}&page=${readPage(href)}&pageSize=${url.searchParams.get('pageSize') ?? ''}&classification=${readClassificationFilter(href)}&selected=${selectedId}`
}

export function buildEmailApiRequestUrl(href: string) {
	const url = new URL(href, 'http://localhost')
	const requestUrl = new URL(accountEmailApiPath, 'http://localhost')
	const query = readSearchQuery(href)
	if (query) requestUrl.searchParams.set('q', query)
	const page = url.searchParams.get('page')
	if (page) requestUrl.searchParams.set('page', page)
	const pageSize = url.searchParams.get('pageSize')
	if (pageSize) requestUrl.searchParams.set('pageSize', pageSize)
	const classification = readClassificationFilter(href)
	if (classification !== 'all') {
		requestUrl.searchParams.set('classification', classification)
	}
	const selectedId = emailRoute.getSelection(href).selectedId
	if (selectedId) requestUrl.searchParams.set('selected', selectedId)
	return `${requestUrl.pathname}${requestUrl.search}`
}

export async function accountEmailRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const response = await fetch(buildEmailApiRequestUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountEmailLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load your email inbox.')
	}
	return { accountEmail: payload }
}

export function messageDate(message: AccountEmailMessageListItem) {
	return message.received_at ?? message.sent_at ?? message.created_at
}

export function statusLabel(message: AccountEmailMessageListItem) {
	if (message.delivery_status) return message.delivery_status
	return message.processing_status
}

export function directionLabel(
	direction: AccountEmailMessageListItem['direction'],
) {
	return direction === 'outbound' ? 'Outbound' : 'Inbound'
}

export function consumeAccountEmailPayload(handle: Handle, href: string) {
	return tryConsumeRouteLoaderData(handle, 'accountEmail', href)
}
