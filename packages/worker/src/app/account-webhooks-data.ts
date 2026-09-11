import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	listWebhooksForUser,
	type ListedWebhook,
} from '#worker/webhooks/service.ts'
import {
	type AccountWebhookListItem,
	type AccountWebhooksLoaderData,
} from '#universal/loader-data.ts'

export type AccountWebhooksUser = Pick<
	AuthenticatedAppUser,
	'username' | 'mcpUser'
>

/** Detail route segments joined the same way the client builds row ids. */
export function accountWebhookItemId(input: {
	packageKodyId: string
	name: string
}) {
	return `${input.packageKodyId}/${input.name}`
}

function toAccountWebhookListItem(
	webhook: ListedWebhook,
): AccountWebhookListItem {
	return {
		id: accountWebhookItemId(webhook),
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
 * Declared package webhooks joined with minted URL state for the signed-in
 * owner. The credential URL is deliberately absent; `/account/webhooks.json`
 * hands it out only through the explicit `reveal` intent.
 */
export async function loadAccountWebhooksData(input: {
	env: Env
	requestUrl: string | URL
	user: AccountWebhooksUser
}): Promise<AccountWebhooksLoaderData> {
	const baseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const webhooks = await listWebhooksForUser({
		env: input.env,
		baseUrl,
		userId: input.user.mcpUser.userId,
	})
	return {
		ok: true,
		username: input.user.username,
		webhooks: webhooks.map(toAccountWebhookListItem),
	}
}
