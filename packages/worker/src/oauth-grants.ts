import { getErrorMessage } from '@kody-internal/shared/error-message.ts'

export type OAuthGrantListItem = {
	id: string
	clientId: string
}

export type OAuthGrantPage = {
	items: Array<OAuthGrantListItem>
	cursor?: string
}

export type OAuthGrantHelpers = {
	listUserGrants(
		userId: string,
		options?: { cursor?: string },
	): Promise<OAuthGrantPage>
	revokeGrant(grantId: string, userId: string): Promise<unknown>
}

export async function listUserOAuthGrants(
	helpers: OAuthGrantHelpers,
	userId: string,
): Promise<Array<OAuthGrantListItem>> {
	const grants = new Array<OAuthGrantListItem>()
	let cursor: string | undefined
	do {
		const page = await helpers.listUserGrants(userId, { cursor })
		for (const grant of page.items) {
			grants.push({ id: grant.id, clientId: grant.clientId })
		}
		cursor = page.cursor
	} while (cursor)
	return grants
}

export async function listUserOAuthGrantsForClient(
	helpers: OAuthGrantHelpers,
	userId: string,
	clientId: string,
): Promise<Array<OAuthGrantListItem>> {
	const grants = await listUserOAuthGrants(helpers, userId)
	return grants.filter((grant) => grant.clientId === clientId)
}

/**
 * Revoke every grant for `userId`. Throws if listing or any revoke fails so
 * password-reset lockout cannot succeed while MCP refresh tokens remain.
 */
export async function revokeAllOAuthGrantsForUser(input: {
	helpers: OAuthGrantHelpers
	userId: string
}): Promise<number> {
	const grants = await listUserOAuthGrants(input.helpers, input.userId)
	for (const grant of grants) {
		await input.helpers.revokeGrant(grant.id, input.userId)
	}
	return grants.length
}

/**
 * Best-effort revoke used by account deletion: listing or per-grant failures
 * become warnings so the rest of the cascade can continue.
 */
export async function revokeAllOAuthGrantsBestEffort(input: {
	helpers: OAuthGrantHelpers
	userId: string
	warnings: Array<string>
}): Promise<number> {
	let cursor: string | undefined
	let revoked = 0
	while (true) {
		let page: OAuthGrantPage
		try {
			page = await input.helpers.listUserGrants(input.userId, { cursor })
		} catch (error) {
			input.warnings.push(
				`OAuth grant listing failed; revoked ${revoked} grant(s) before the failure: ${getErrorMessage(error)}`,
			)
			return revoked
		}
		for (const grant of page.items) {
			try {
				await input.helpers.revokeGrant(grant.id, input.userId)
				revoked += 1
			} catch (error) {
				input.warnings.push(
					`OAuth grant revoke failed for grant ${grant.id}: ${getErrorMessage(error)}`,
				)
			}
		}
		if (!page.cursor) return revoked
		cursor = page.cursor
	}
}
