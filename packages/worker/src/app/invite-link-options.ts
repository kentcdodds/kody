import { routes } from '#universal/routes.ts'

const MAX_INVITE_LINK_EXPIRY_DAYS = 365

export type InviteLinkOptions = {
	allowedEmailDomains: Array<string>
	maxUses: number | null
	expiresAt: string | undefined
}

function parseDomainList(value: unknown): Array<string> | null {
	if (value == null) return []
	if (typeof value === 'string') {
		return value
			.split(/[\s,]+/)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)
	}
	if (Array.isArray(value)) {
		if (value.some((entry) => entry != null && typeof entry !== 'string')) {
			return null
		}
		return value
			.filter((entry): entry is string => typeof entry === 'string')
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)
	}
	return null
}

/**
 * Domains, max uses, and expiry from a create-link request body. Every link
 * surface (Members, Teams, package Collaborators) reads them the same way.
 */
export function readInviteLinkOptions(
	body: Record<string, unknown> | null,
): { ok: true; options: InviteLinkOptions } | { ok: false; error: string } {
	const domains = parseDomainList(
		body?.allowedEmailDomains ?? body?.domains ?? body?.allowedDomains,
	)
	if (domains == null) {
		return {
			ok: false,
			error: 'Allowed email domains must be a list or string.',
		}
	}
	let maxUses: number | null = null
	if (
		body?.maxUses !== undefined &&
		body?.maxUses !== null &&
		body?.maxUses !== ''
	) {
		const parsed =
			typeof body.maxUses === 'number'
				? body.maxUses
				: typeof body.maxUses === 'string'
					? Number(body.maxUses)
					: NaN
		if (!Number.isInteger(parsed) || parsed < 1) {
			return { ok: false, error: 'Max uses must be a positive integer.' }
		}
		maxUses = parsed
	}
	let expiresAt: string | undefined
	if (typeof body?.expiresAt === 'string' && body.expiresAt.trim()) {
		const parsed = Date.parse(body.expiresAt)
		if (Number.isNaN(parsed)) {
			return { ok: false, error: 'Enter a valid expiry date.' }
		}
		expiresAt = new Date(parsed).toISOString()
	} else if (
		body?.expiresInDays !== undefined &&
		body?.expiresInDays !== null &&
		body?.expiresInDays !== ''
	) {
		const days =
			typeof body.expiresInDays === 'number'
				? body.expiresInDays
				: typeof body.expiresInDays === 'string'
					? Number(body.expiresInDays)
					: NaN
		if (
			!Number.isFinite(days) ||
			days <= 0 ||
			days > MAX_INVITE_LINK_EXPIRY_DAYS
		) {
			return {
				ok: false,
				error: `Expiry days must be between 1 and ${MAX_INVITE_LINK_EXPIRY_DAYS}.`,
			}
		}
		expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
	}
	return {
		ok: true,
		options: { allowedEmailDomains: domains, maxUses, expiresAt },
	}
}

export function inviteLinkUrl(request: Request, token: string) {
	return `${new URL(request.url).origin}${routes.orgInviteJoin.href({ token })}`
}
