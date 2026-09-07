/**
 * Distinct inbound MCP OAuth clientIds. Pages every grant — do not use first-
 * page grant count as a client count (two grants for one host are one client).
 *
 * PR #2119 owns the labeled Connected-agents list
 * (`loadInboundMcpConnectionState`). This helper is the campaign-sized read
 * of the same rule: paginate `listUserGrants`, count unique `clientId`s.
 */

export type CampaignGrantPage = {
	items: Array<{ clientId?: string | null }>
	cursor?: string
}

export type CampaignGrantListHelpers = {
	listUserGrants(
		userId: string,
		options?: { cursor?: string },
	): Promise<CampaignGrantPage>
}

const maxGrantPages = 50

export async function countDistinctInboundClientIds(
	helpers: CampaignGrantListHelpers | undefined,
	userId: string,
): Promise<{ uniqueClientCount: number; listingFailed: boolean }> {
	if (!helpers) return { uniqueClientCount: 0, listingFailed: false }
	const clientIds = new Set<string>()
	let cursor: string | undefined
	try {
		for (let pageIndex = 0; pageIndex < maxGrantPages; pageIndex++) {
			const page = await helpers.listUserGrants(userId, { cursor })
			for (const grant of page.items) {
				const clientId = grant.clientId?.trim() ?? ''
				if (clientId !== '') clientIds.add(clientId)
			}
			if (!page.cursor) {
				return { uniqueClientCount: clientIds.size, listingFailed: false }
			}
			cursor = page.cursor
		}
		return { uniqueClientCount: clientIds.size, listingFailed: false }
	} catch {
		return { uniqueClientCount: 0, listingFailed: true }
	}
}
