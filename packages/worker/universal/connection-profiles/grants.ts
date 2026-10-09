/**
 * Generic connection-profile grants. A grant is resource type + id + actions.
 * V1 accepts only `package` with `read` and/or `execute`. The string form
 * (`package:<id>:read`) is reusable as an API/OAuth scope later.
 */

const connectionProfileResourceTypes = ['package'] as const
type ConnectionProfileResourceType =
	(typeof connectionProfileResourceTypes)[number]

const connectionProfileActions = ['read', 'execute', 'write'] as const
export type ConnectionProfileAction = (typeof connectionProfileActions)[number]

/** Actions accepted when writing a profile in v1. */
const connectionProfileV1Actions = ['read', 'execute'] as const
type ConnectionProfileV1Action = (typeof connectionProfileV1Actions)[number]

export type ConnectionProfileGrant = {
	resourceType: ConnectionProfileResourceType
	resourceId: string
	actions: Array<ConnectionProfileAction>
}

export type ConnectionProfileGrantString =
	`${string}:${string}:${ConnectionProfileAction}`

const actionSet: ReadonlySet<string> = new Set(connectionProfileActions)
const v1ActionSet: ReadonlySet<string> = new Set(connectionProfileV1Actions)
const resourceTypeSet: ReadonlySet<string> = new Set(
	connectionProfileResourceTypes,
)

function isConnectionProfileResourceType(
	value: unknown,
): value is ConnectionProfileResourceType {
	return typeof value === 'string' && resourceTypeSet.has(value)
}

function isConnectionProfileAction(
	value: unknown,
): value is ConnectionProfileAction {
	return typeof value === 'string' && actionSet.has(value)
}

function isConnectionProfileV1Action(
	value: unknown,
): value is ConnectionProfileV1Action {
	return typeof value === 'string' && v1ActionSet.has(value)
}

export function formatConnectionProfileGrantString(input: {
	resourceType: string
	resourceId: string
	action: ConnectionProfileAction
}): ConnectionProfileGrantString {
	return `${input.resourceType}:${input.resourceId}:${input.action}`
}

/**
 * Parse `type:id:action`. Resource ids may contain `:`; action is the last
 * segment and type is the first.
 */
export function parseConnectionProfileGrantString(value: string): {
	resourceType: string
	resourceId: string
	action: ConnectionProfileAction
} | null {
	const trimmed = value.trim()
	const firstColon = trimmed.indexOf(':')
	const lastColon = trimmed.lastIndexOf(':')
	if (firstColon <= 0 || lastColon <= firstColon) return null
	const resourceType = trimmed.slice(0, firstColon)
	const resourceId = trimmed.slice(firstColon + 1, lastColon)
	const action = trimmed.slice(lastColon + 1)
	if (!resourceType || !resourceId || !isConnectionProfileAction(action)) {
		return null
	}
	return { resourceType, resourceId, action }
}

/**
 * Single allowlist check. `grants === null` / `undefined` means unlimited
 * (no named profile). A named profile with an empty grant list denies
 * everything — never treat empty as unlimited once a profile is present.
 */
export function connectionProfileAllows(input: {
	grants: ReadonlyArray<ConnectionProfileGrant> | null | undefined
	resourceType: string
	resourceId: string
	action: ConnectionProfileAction
}): boolean {
	if (input.grants == null) return true
	for (const grant of input.grants) {
		if (
			grant.resourceType === input.resourceType &&
			grant.resourceId === input.resourceId &&
			grant.actions.includes(input.action)
		) {
			return true
		}
	}
	return false
}

export function parseConnectionProfileGrantsJson(
	value: unknown,
): Array<ConnectionProfileGrant> {
	if (typeof value !== 'string') {
		throw new Error('Profile grants must be a JSON string.')
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		throw new Error('Profile grants JSON is invalid.')
	}
	return normalizeConnectionProfileGrants(parsed)
}

/**
 * Normalize and validate grants for storage. V1 rejects non-package types and
 * `write` rather than building UI for them.
 */
export function normalizeConnectionProfileGrants(
	value: unknown,
): Array<ConnectionProfileGrant> {
	if (!Array.isArray(value)) {
		throw new Error('Profile grants must be an array.')
	}
	const byKey = new Map<string, ConnectionProfileGrant>()
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') {
			throw new Error('Each profile grant must be an object.')
		}
		const record = entry as Record<string, unknown>
		const resourceType =
			typeof record.resourceType === 'string'
				? record.resourceType.trim()
				: typeof record.resource_type === 'string'
					? record.resource_type.trim()
					: ''
		const resourceId =
			typeof record.resourceId === 'string'
				? record.resourceId.trim()
				: typeof record.resource_id === 'string'
					? record.resource_id.trim()
					: ''
		if (!resourceType || !resourceId) {
			throw new Error('Each profile grant needs resourceType and resourceId.')
		}
		if (!isConnectionProfileResourceType(resourceType)) {
			throw new Error(
				`Unsupported connection profile resource type "${resourceType}". Only "package" is accepted.`,
			)
		}
		const rawActions = record.actions
		if (!Array.isArray(rawActions) || rawActions.length === 0) {
			throw new Error('Each profile grant needs a non-empty actions array.')
		}
		const actions = new Array<ConnectionProfileAction>()
		for (const action of rawActions) {
			if (!isConnectionProfileAction(action)) {
				throw new Error(
					`Unknown connection profile action "${String(action)}".`,
				)
			}
			if (action === 'write') {
				throw new Error(
					'Connection profile action "write" is not accepted yet.',
				)
			}
			if (!isConnectionProfileV1Action(action)) {
				throw new Error(
					`Unsupported connection profile action "${action}" in v1.`,
				)
			}
			if (!actions.includes(action)) actions.push(action)
		}
		actions.sort()
		const key = `${resourceType}\0${resourceId}`
		const existing = byKey.get(key)
		if (existing) {
			for (const action of actions) {
				if (!existing.actions.includes(action)) existing.actions.push(action)
			}
			existing.actions.sort()
		} else {
			byKey.set(key, { resourceType, resourceId, actions })
		}
	}
	return [...byKey.values()].sort((left, right) => {
		const typeCmp = left.resourceType.localeCompare(right.resourceType)
		if (typeCmp !== 0) return typeCmp
		return left.resourceId.localeCompare(right.resourceId)
	})
}

export function serializeConnectionProfileGrants(
	grants: ReadonlyArray<ConnectionProfileGrant>,
) {
	return JSON.stringify(grants)
}
