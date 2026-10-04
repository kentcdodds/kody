import {
	getConnectionProfileNameValidationError,
	normalizeConnectionProfileName,
	readConnectionProfileNameFromUrl,
	stripConnectionProfileFromResourceUri,
} from '#universal/connection-profiles/names.ts'
import { connectionProfilesFlagKey } from '#universal/feature-flags/registry.ts'
import { isFeatureEnabled } from '#worker/feature-flags/service.ts'
import { getConnectionProfileByName } from '#worker/connection-profiles/repo.ts'
import { mcpOAuthResourceUri } from '#worker/oauth-provider-options.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { type AuthRequest } from '@cloudflare/workers-oauth-provider'

/**
 * Resolve the connection profile name for an authorize request, and normalize
 * `authRequest.resource` to the canonical `/mcp` audience (strip `?profile=`).
 */
export async function resolveAuthorizeConnectionProfile(input: {
	env: Env
	request: Request
	authRequest: AuthRequest
	userId: string
}): Promise<string | null> {
	const fromAuthorizeUrl = readConnectionProfileNameFromUrl(input.request.url)
	let fromResource: string | null = null
	if (typeof input.authRequest.resource === 'string') {
		const stripped = stripConnectionProfileFromResourceUri(
			input.authRequest.resource,
		)
		fromResource = stripped.profileName
		const origin = getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		})
		const canonical = mcpOAuthResourceUri(origin)
		// Only rewrite when the path matched `/mcp` with an optional profile query.
		try {
			const resourceUrl = new URL(stripped.canonicalResource)
			const canonicalUrl = new URL(canonical)
			if (
				resourceUrl.origin === canonicalUrl.origin &&
				resourceUrl.pathname.replace(/\/$/, '') ===
					canonicalUrl.pathname.replace(/\/$/, '')
			) {
				input.authRequest.resource = canonical
			}
		} catch {
			// Leave resource unchanged when it is not a URL we can normalize.
		}
	}

	const candidate = fromAuthorizeUrl ?? fromResource
	if (!candidate) return null

	const name = normalizeConnectionProfileName(candidate)
	if (getConnectionProfileNameValidationError(name)) return null

	const enabled = await isFeatureEnabled(
		input.env.APP_DB,
		connectionProfilesFlagKey,
		await resolveDbUserId(input.env.APP_DB, input.userId),
	)
	if (!enabled) return null

	const profile = await getConnectionProfileByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	// Unknown profile name: do not bind (avoid locking a grant to a typo).
	return profile ? profile.name : null
}

async function resolveDbUserId(db: D1Database, stableUserId: string) {
	const row = await db
		.prepare(`SELECT id FROM users WHERE stable_user_id = ?`)
		.bind(stableUserId)
		.first<{ id: number }>()
	return row?.id ?? null
}

export function connectionProfileGrantFields(profileName: string | null): {
	props: { connectionProfileName?: string }
	metadata: { connectionProfileName?: string }
} {
	if (!profileName) return { props: {}, metadata: {} }
	return {
		props: { connectionProfileName: profileName },
		metadata: { connectionProfileName: profileName },
	}
}

export function readConnectionProfileNameFromGrantProps(
	props: unknown,
): string | null {
	if (!props || typeof props !== 'object') return null
	const value = (props as { connectionProfileName?: unknown })
		.connectionProfileName
	if (typeof value !== 'string') return null
	const name = normalizeConnectionProfileName(value)
	return name.length > 0 ? name : null
}

export function readConnectionProfileNameFromGrantMetadata(
	metadata: unknown,
): string | null {
	if (!metadata || typeof metadata !== 'object') return null
	const value = (metadata as { connectionProfileName?: unknown })
		.connectionProfileName
	if (typeof value !== 'string') return null
	const name = normalizeConnectionProfileName(value)
	return name.length > 0 ? name : null
}
