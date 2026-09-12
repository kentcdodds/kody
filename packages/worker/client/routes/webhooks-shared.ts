import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	type AccountWebhooksLoaderData,
	type PackageWebhookListItem,
	type PackageWebhooksActionPayload,
	type PackageWebhooksLoaderData,
} from '#universal/loader-data.ts'
import { docHref } from '#universal/docs-nav.ts'
import { routes } from '#universal/routes.ts'
import { colors } from '#universal/styles/tokens.ts'

const accountWebhooksApiPath = routes.accountWebhooksApi.href()

/** The triggers guide section on inbound webhooks (`docs/guides/triggers.md`). */
export const webhooksDocHref = `${docHref('triggers')}#inbound-webhooks-the-external-http-knock`

/** Activity filtered to webhook deliveries (metadata only; bodies are never stored). */
export const webhookDeliveriesHref = `${routes.accountActivity.href()}?view=recent&status=all&surface=webhook`

export type WebhookIntent = 'mint' | 'rotate' | 'reveal' | 'enable' | 'disable'

/** Anchor of the Webhooks section on package settings. */
export const packageWebhooksSectionId = 'webhooks'

/** Anchor of one webhook's card inside that section. */
export function packageWebhookCardId(webhookName: string) {
	return `webhook-${webhookName}`
}

/**
 * Package settings is where URLs get minted and copied; the account index
 * and any "manage this webhook" link land on the owning package's section
 * (or one webhook's card when the name is known).
 */
export function buildPackageWebhooksHref(input: {
	username: string
	kodyId: string
	webhookName?: string | null
}) {
	const settingsHref = routes.communityPackageSettings.href({
		username: input.username,
		kodyId: input.kodyId,
	})
	const anchor = input.webhookName
		? packageWebhookCardId(input.webhookName)
		: packageWebhooksSectionId
	return `${settingsHref}#${anchor}`
}

function packageWebhooksApiHref(input: { username: string; kodyId: string }) {
	return routes.communityPackageWebhooksApi.href(input)
}

export function webhookStatusLabel(
	webhook: Pick<PackageWebhookListItem, 'minted' | 'enabled'>,
) {
	if (!webhook.minted) return 'No URL yet'
	return webhook.enabled ? 'Active' : 'Disabled'
}

export function webhookStatusColor(
	webhook: Pick<PackageWebhookListItem, 'minted' | 'enabled'>,
) {
	if (!webhook.minted) return colors.textMuted
	return webhook.enabled ? colors.primary : colors.error
}

export function webhookModeLabel(
	webhook: Pick<PackageWebhookListItem, 'responseMode' | 'inputMode'>,
) {
	return `${webhook.responseMode} · ${webhook.inputMode}`
}

export function webhookVerificationLabel(
	webhook: Pick<PackageWebhookListItem, 'verification'>,
) {
	if (!webhook.verification) return 'URL secret only'
	return `${webhook.verification.type} · ${webhook.verification.header}`
}

export function webhookSuccessMessage(intent: WebhookIntent) {
	switch (intent) {
		case 'mint':
			return 'Webhook URL minted. Copy it now and paste it into the provider.'
		case 'rotate':
			return 'Webhook URL rotated. The previous URL stays active until the new one receives a delivery, or for 24 hours.'
		case 'reveal':
			return null
		case 'enable':
			return 'Webhook enabled.'
		case 'disable':
			return 'Webhook disabled. Deliveries now answer 404.'
		default: {
			const exhaustive: never = intent
			return String(exhaustive)
		}
	}
}

export function webhookFailureMessage(intent: WebhookIntent) {
	switch (intent) {
		case 'mint':
			return 'Unable to mint the webhook URL.'
		case 'rotate':
			return 'Unable to rotate the webhook URL.'
		case 'reveal':
			return 'Unable to reveal the webhook URL.'
		case 'enable':
			return 'Unable to enable the webhook.'
		case 'disable':
			return 'Unable to disable the webhook.'
		default: {
			const exhaustive: never = intent
			return String(exhaustive)
		}
	}
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

export type PackageWebhooksFetchResult =
	| { kind: 'unauthorized' }
	| { kind: 'ok'; payload: PackageWebhooksLoaderData }

export async function fetchPackageWebhooks(input: {
	username: string
	kodyId: string
	signal?: AbortSignal
}): Promise<PackageWebhooksFetchResult> {
	const response = await fetch(packageWebhooksApiHref(input), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal: input.signal,
	})
	if (response.status === 401) return { kind: 'unauthorized' }
	const payload = await readJson<PackageWebhooksLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load webhooks.')
	}
	return { kind: 'ok', payload }
}

export type PackageWebhookIntentResult =
	| { kind: 'unauthorized' }
	| { kind: 'ok'; payload: PackageWebhooksActionPayload }
	| { kind: 'error'; message: string }

/**
 * Runs one intent against the package webhooks API. Only `mint`, `rotate`,
 * and `reveal` answers carry `revealed`; the caller keeps that URL in memory
 * and never in a payload it re-renders from.
 */
export async function postPackageWebhookIntent(input: {
	username: string
	kodyId: string
	webhookName: string
	intent: WebhookIntent
}): Promise<PackageWebhookIntentResult> {
	try {
		const response = await fetch(packageWebhooksApiHref(input), {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			credentials: 'include',
			body: JSON.stringify({
				intent: input.intent,
				webhookName: input.webhookName,
			}),
		})
		if (response.status === 401) return { kind: 'unauthorized' }
		const payload = await readJson<
			PackageWebhooksActionPayload & { error?: string; ok?: boolean }
		>(response)
		if (!response.ok || !payload?.ok) {
			return {
				kind: 'error',
				message: payload?.error || webhookFailureMessage(input.intent),
			}
		}
		return { kind: 'ok', payload }
	} catch {
		return { kind: 'error', message: webhookFailureMessage(input.intent) }
	}
}
