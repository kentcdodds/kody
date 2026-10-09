/**
 * Org id stamped onto MCP OAuth grants (props + metadata). Public surfaces
 * show slugs; this id is the internal grant binding (ADR 0064).
 */

export function orgGrantFields(orgId: string): {
	props: { orgId: string }
	metadata: { orgId: string }
} {
	return {
		props: { orgId },
		metadata: { orgId },
	}
}

function readOrgIdField(value: unknown, key: 'orgId'): string | null {
	if (!value || typeof value !== 'object') return null
	const orgId = (value as { orgId?: unknown })[key]
	if (typeof orgId !== 'string') return null
	const trimmed = orgId.trim()
	return trimmed.length > 0 ? trimmed : null
}

export function readOrgIdFromGrantProps(props: unknown): string | null {
	return readOrgIdField(props, 'orgId')
}

export function readOrgIdFromGrantMetadata(metadata: unknown): string | null {
	return readOrgIdField(metadata, 'orgId')
}

export type TokenExchangeOrgStampInput = {
	props?: unknown
	grantType?: string
}

/**
 * Backfill `orgId` on token exchange. Spec: `orgId = props.orgId ?? props.userId`.
 * No-op when already stamped or when neither field is a string.
 */
export function readOrgIdFromGrantPropsOrUserId(props: unknown): string | null {
	const stamped = readOrgIdFromGrantProps(props)
	if (stamped) return stamped
	if (!props || typeof props !== 'object') return null
	const userId = (props as { userId?: unknown }).userId
	if (typeof userId !== 'string') return null
	const trimmed = userId.trim()
	return trimmed.length > 0 ? trimmed : null
}

export function stampOrgIdOnTokenExchange(
	input: TokenExchangeOrgStampInput,
): { newProps: Record<string, unknown> } | undefined {
	const props = input.props
	if (!props || typeof props !== 'object') return
	const record = props as Record<string, unknown>
	const stamped =
		typeof record.orgId === 'string' && record.orgId.trim().length > 0
			? record.orgId.trim()
			: null
	const fallback =
		typeof record.userId === 'string' && record.userId.trim().length > 0
			? record.userId.trim()
			: null
	const orgId = stamped ?? fallback
	if (!orgId) return
	if (stamped === orgId) return
	return { newProps: { ...record, orgId } }
}
