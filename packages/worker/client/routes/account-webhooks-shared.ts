import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	type AccountWebhookListItem,
	type AccountWebhooksLoaderData,
} from '#universal/loader-data.ts'
import { docHref } from '#universal/docs-nav.ts'
import { routes } from '#universal/routes.ts'
import { colors } from '#universal/styles/tokens.ts'

export const accountWebhooksApiPath = routes.accountWebhooksApi.href()

/** The triggers guide section on inbound webhooks (`docs/guides/triggers.md`). */
export const webhooksDocHref = `${docHref('triggers')}#inbound-webhooks-the-external-http-knock`

/** Activity filtered to webhook deliveries (metadata only; bodies are never stored). */
export const webhookDeliveriesHref = `${routes.accountActivity.href()}?view=recent&status=all&surface=webhook`

const listPath = routes.accountWebhooks.href()
const detailPrefix = `${listPath}/`

function decodePathSegment(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

/**
 * `/account/webhooks/:packageKodyId/:webhookName` selects one declared
 * webhook. The row id is the same two segments joined with `/`, so the list
 * payload can answer the detail without a second fetch.
 */
export function readWebhookSelection(href: string) {
	const pathname = new URL(href, 'http://localhost').pathname
	if (!pathname.startsWith(detailPrefix)) return null
	const segments = pathname
		.slice(detailPrefix.length)
		.split('/')
		.filter(Boolean)
	if (segments.length !== 2) return null
	const [packageKodyId, webhookName] = segments.map(decodePathSegment)
	if (!packageKodyId || !webhookName) return null
	return `${packageKodyId}/${webhookName}`
}

export function buildWebhookDetailHref(
	webhook: Pick<AccountWebhookListItem, 'packageKodyId' | 'name'>,
) {
	return routes.accountWebhookDetail.href({
		packageKodyId: webhook.packageKodyId,
		webhookName: webhook.name,
	})
}

/** Every webhook route shares the one list payload. */
export function getWebhooksDataLatchKey(_href: string) {
	return listPath
}

export function webhookStatusLabel(
	webhook: Pick<AccountWebhookListItem, 'minted' | 'enabled'>,
) {
	if (!webhook.minted) return 'No URL yet'
	return webhook.enabled ? 'Active' : 'Disabled'
}

export function webhookStatusColor(
	webhook: Pick<AccountWebhookListItem, 'minted' | 'enabled'>,
) {
	if (!webhook.minted) return colors.textMuted
	return webhook.enabled ? colors.primary : colors.error
}

export function webhookModeLabel(
	webhook: Pick<AccountWebhookListItem, 'responseMode' | 'inputMode'>,
) {
	return `${webhook.responseMode} · ${webhook.inputMode}`
}

export function webhookVerificationLabel(
	webhook: Pick<AccountWebhookListItem, 'verification'>,
) {
	if (!webhook.verification) return 'URL secret only'
	return `${webhook.verification.type} · ${webhook.verification.header}`
}

export async function fetchAccountWebhooks(signal: AbortSignal) {
	const response = await fetch(accountWebhooksApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) return { kind: 'unauthorized' as const }
	const payload = await readJson<AccountWebhooksLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load webhooks.')
	}
	return { kind: 'ok' as const, payload }
}

export async function accountWebhooksRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const result = await fetchAccountWebhooks(signal)
	if (result.kind === 'unauthorized') {
		return routeLoaderRedirect('/login')
	}
	return { accountWebhooks: result.payload }
}
