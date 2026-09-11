import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	listWebhooksForUser,
	type ListedWebhook,
} from '#worker/webhooks/service.ts'
import {
	type AccountWebhooksLoaderData,
	type PackageWebhookListItem,
	type PackageWebhooksLoaderData,
} from '#universal/loader-data.ts'

export type WebhooksUser = Pick<AuthenticatedAppUser, 'username' | 'mcpUser'>

/** Row id shared by the list payloads and the `revealed` entry. */
export function packageWebhookItemId(input: {
	packageKodyId: string
	name: string
}) {
	return `${input.packageKodyId}/${input.name}`
}

function toPackageWebhookListItem(
	webhook: ListedWebhook,
): PackageWebhookListItem {
	return {
		id: packageWebhookItemId(webhook),
		packageId: webhook.packageId,
		packageKodyId: webhook.packageKodyId,
		packageName: webhook.packageName,
		name: webhook.name,
		exportName: webhook.exportName,
		description: webhook.description,
		responseMode: webhook.responseMode,
		inputMode: webhook.inputMode,
		rateLimitPerMinute: webhook.rateLimitPerMinute,
		verification: webhook.verification,
		replay: webhook.replay,
		minted: webhook.minted,
		handle: webhook.handle,
		urlHost: webhook.urlHost,
		enabled: webhook.enabled,
		urlRecoverable: webhook.urlRecoverable,
		createdAt: webhook.createdAt,
		rotatedAt: webhook.rotatedAt,
	}
}

/**
 * Declared webhooks joined with minted URL state for the signed-in owner,
 * optionally narrowed to one package. The credential URL is deliberately
 * absent; only the package webhooks API's `reveal` intent hands it out.
 */
async function listWebhookItems(input: {
	env: Env
	requestUrl: string | URL
	user: WebhooksUser
	kodyId?: string
}) {
	const baseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const webhooks = await listWebhooksForUser({
		env: input.env,
		baseUrl,
		userId: input.user.mcpUser.userId,
		kodyId: input.kodyId,
	})
	return webhooks.map(toPackageWebhookListItem)
}

/** `/account/webhooks.json`: every package's declared webhooks. */
export async function loadAccountWebhooksData(input: {
	env: Env
	requestUrl: string | URL
	user: WebhooksUser
}): Promise<AccountWebhooksLoaderData> {
	return {
		ok: true,
		username: input.user.username,
		webhooks: await listWebhookItems(input),
	}
}

/** `/profiles/:username/packages/:kodyId/webhooks.json`: one package. */
export async function loadPackageWebhooksData(input: {
	env: Env
	requestUrl: string | URL
	user: WebhooksUser
	kodyId: string
}): Promise<PackageWebhooksLoaderData> {
	return {
		ok: true,
		username: input.user.username,
		kodyId: input.kodyId,
		webhooks: await listWebhookItems(input),
	}
}
