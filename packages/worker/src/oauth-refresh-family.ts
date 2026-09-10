import * as Sentry from '@sentry/cloudflare'
import {
	decryptSecretValue,
	encryptSecretValue,
} from '#worker/mcp/secrets/crypto.ts'

/**
 * MCP hosts on one machine often share a stored OAuth client but keep their
 * own in-memory refresh token. The provider rotates on every refresh and only
 * keeps a 1-deep previous token; reusing that previous token mints a *new*
 * refresh token and silently invalidates the sibling that already received
 * the current one (`RT1→RT2`, `RT1→RT3`, `RT2→invalid_grant`).
 *
 * Kody keeps an encrypted snapshot of the current family tokens and treats
 * reuse of the immediately previous refresh token as idempotent: return the
 * current tokens without rotating, even when the stored access token is near
 * expiry. A one-hour replay of the consumed token returns that same current
 * family while the hash still matches. Tokens outside that family do not
 * mint. Refresh grants for one user/grant pair run one at a time in this
 * isolate so overlapping first-use siblings re-read the snapshot after the
 * first rotation. See
 * `docs/contributing/architecture/authentication.md`.
 */

const mcpOAuthRefreshFamilyReplayTtlSeconds = 60 * 60
const mcpOAuthRefreshFamilySnapshotTtlSeconds = 60 * 60 * 2

const refreshFamilySnapshotKeyPrefix =
	'derived-cache:v1:mcp-oauth-refresh-family:'
const refreshFamilyReplayKeyPrefix =
	'derived-cache:v1:mcp-oauth-refresh-replay:'

export type RefreshFamilyActionKind =
	| 'return-snapshot'
	| 'return-replay'
	| 'pass-through'

export type RefreshFamilyAction = { kind: RefreshFamilyActionKind }

export type RefreshFamilyGrantIds = {
	currentRefreshTokenHash?: string
	previousRefreshTokenHash?: string
}

export type RefreshFamilySnapshot = {
	userId: string
	grantId: string
	currentRefreshTokenHash: string
	refreshToken: string
	accessToken: string
	accessExpiresAt: number
	tokenType: string
	scope: string
	resource?: string
}

type StoredGrantRecord = {
	refreshTokenId?: string
	previousRefreshTokenId?: string
}

type TokenResponseBody = {
	access_token?: unknown
	refresh_token?: unknown
	token_type?: unknown
	expires_in?: unknown
	scope?: unknown
	resource?: unknown
}

export function mcpOAuthRefreshFamilySnapshotKey(
	userId: string,
	grantId: string,
) {
	return `${refreshFamilySnapshotKeyPrefix}${userId}:${grantId}`
}

export function mcpOAuthRefreshFamilyReplayKey(
	userId: string,
	grantId: string,
	tokenHash: string,
) {
	return `${refreshFamilyReplayKeyPrefix}${userId}:${grantId}:${tokenHash}`
}

export function parseOAuthRefreshToken(token: string) {
	const parts = token.split(':')
	const userId = parts[0]
	const grantId = parts[1]
	if (
		parts.length !== 3 ||
		!userId ||
		!grantId ||
		parts.some((part) => part.length === 0)
	) {
		return null
	}
	return { userId, grantId }
}

export async function hashOAuthToken(token: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(token),
	)
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

export function decideRefreshFamilyAction(input: {
	presentedHash: string
	grant: RefreshFamilyGrantIds | null
	snapshot: RefreshFamilySnapshot | null
	replay: RefreshFamilySnapshot | null
}): RefreshFamilyAction {
	const replayIsCurrentFamily =
		input.replay !== null &&
		input.grant !== null &&
		input.replay.currentRefreshTokenHash === input.grant.currentRefreshTokenHash
	if (replayIsCurrentFamily) {
		return { kind: 'return-replay' }
	}
	if (!input.grant || !input.snapshot) {
		return { kind: 'pass-through' }
	}
	const snapshotMatchesCurrent =
		input.snapshot.currentRefreshTokenHash ===
		input.grant.currentRefreshTokenHash
	if (!snapshotMatchesCurrent) {
		return { kind: 'pass-through' }
	}
	if (input.presentedHash === input.grant.previousRefreshTokenHash) {
		return { kind: 'return-snapshot' }
	}
	return { kind: 'pass-through' }
}

const refreshFamilyGrantLocks = new Map<string, Promise<void>>()

function refreshFamilyGrantLockKey(userId: string, grantId: string) {
	return `${userId}:${grantId}`
}

async function withRefreshFamilyGrantLock<T>(
	userId: string,
	grantId: string,
	work: () => Promise<T>,
): Promise<T> {
	const key = refreshFamilyGrantLockKey(userId, grantId)
	let release = () => {}
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	const previous = refreshFamilyGrantLocks.get(key) ?? Promise.resolve()
	const tail = previous.then(
		() => held,
		() => held,
	)
	refreshFamilyGrantLocks.set(key, tail)
	try {
		await previous.catch(() => undefined)
		return await work()
	} finally {
		release()
		if (refreshFamilyGrantLocks.get(key) === tail) {
			refreshFamilyGrantLocks.delete(key)
		}
	}
}

export async function handleMcpOAuthTokenRequest(input: {
	request: Request
	env: Env
	fetchProvider: (request: Request) => Promise<Response>
}) {
	const formData = await input.request
		.clone()
		.formData()
		.catch(() => null)
	const grantType = readFormString(formData?.get('grant_type'))
	if (grantType === 'refresh_token' && formData) {
		const presented = readFormString(formData.get('refresh_token'))
		const parsed = presented ? parseOAuthRefreshToken(presented) : null
		if (parsed) {
			return withRefreshFamilyGrantLock(parsed.userId, parsed.grantId, () =>
				completeMcpOAuthTokenRequest(input, formData, grantType),
			)
		}
	}
	return completeMcpOAuthTokenRequest(input, formData, grantType)
}

async function completeMcpOAuthTokenRequest(
	input: {
		request: Request
		env: Env
		fetchProvider: (request: Request) => Promise<Response>
	},
	formData: FormData | null,
	grantType: string | null,
) {
	if (grantType === 'refresh_token' && formData) {
		const reuseResponse = await tryRefreshFamilyReuse({
			request: input.request,
			env: input.env,
			formData,
			fetchProvider: input.fetchProvider,
		})
		if (reuseResponse) {
			return {
				response: addOAuthTokenCorsHeaders(reuseResponse, input.request),
				grantType,
			}
		}
	}
	const response = await input.fetchProvider(input.request)
	if (response.ok) {
		await persistRefreshFamilyBestEffort({
			env: input.env,
			response,
			presentedRefreshToken:
				grantType === 'refresh_token'
					? readFormString(formData?.get('refresh_token'))
					: null,
		})
	}
	return { response, grantType }
}

function readFormString(value: FormDataEntryValue | null | undefined) {
	return typeof value === 'string' && value.length > 0 ? value : null
}

async function tryRefreshFamilyReuse(input: {
	request: Request
	env: Env
	formData: FormData
	fetchProvider: (request: Request) => Promise<Response>
}) {
	const presented = readFormString(input.formData.get('refresh_token'))
	if (!presented) return null
	const parsed = parseOAuthRefreshToken(presented)
	if (!parsed) return null
	const presentedHash = await hashOAuthToken(presented)
	const replay = await readRefreshFamilySnapshotAtKey(
		input.env,
		mcpOAuthRefreshFamilyReplayKey(
			parsed.userId,
			parsed.grantId,
			presentedHash,
		),
		parsed,
	)
	const snapshot = await readRefreshFamilySnapshot(
		input.env,
		parsed.userId,
		parsed.grantId,
	)
	const grant = await readGrantRefreshIds(
		input.env,
		parsed.userId,
		parsed.grantId,
	)
	const action = decideRefreshFamilyAction({
		presentedHash,
		grant,
		snapshot,
		replay,
	})
	switch (action.kind) {
		case 'return-replay':
			return replay ? createFamilyTokenResponse(replay) : null
		case 'return-snapshot':
			return snapshot ? createFamilyTokenResponse(snapshot) : null
		case 'pass-through':
			return null
		default: {
			const exhaustive: never = action.kind
			throw new Error(`unexpected refresh family action: ${exhaustive}`)
		}
	}
}

async function persistRefreshFamilyBestEffort(input: {
	env: Env
	response: Response
	presentedRefreshToken: string | null
}) {
	try {
		await persistRefreshFamilyFromTokenResponse(input)
	} catch (error) {
		// Snapshot writes are best-effort. The provider already minted tokens;
		// a KV or encrypt failure must not hide that response.
		Sentry.captureException(error)
	}
}

async function persistRefreshFamilyFromTokenResponse(input: {
	env: Env
	response: Response
	presentedRefreshToken: string | null
}) {
	if (!canPersistRefreshFamily(input.env)) return
	const body = (await input.response
		.clone()
		.json()
		.catch(() => null)) as TokenResponseBody | null
	if (!body || typeof body.refresh_token !== 'string') return
	if (typeof body.access_token !== 'string') return
	const parsed = parseOAuthRefreshToken(body.refresh_token)
	if (!parsed) return
	const expiresIn =
		typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
			? Math.floor(body.expires_in)
			: null
	if (expiresIn === null || expiresIn < 1) return
	const nowSeconds = Math.floor(Date.now() / 1000)
	const snapshot: RefreshFamilySnapshot = {
		userId: parsed.userId,
		grantId: parsed.grantId,
		currentRefreshTokenHash: await hashOAuthToken(body.refresh_token),
		refreshToken: body.refresh_token,
		accessToken: body.access_token,
		accessExpiresAt: nowSeconds + expiresIn,
		tokenType: typeof body.token_type === 'string' ? body.token_type : 'bearer',
		scope: typeof body.scope === 'string' ? body.scope : '',
		resource: typeof body.resource === 'string' ? body.resource : undefined,
	}
	await writeRefreshFamilySnapshot(input.env, snapshot)
	if (input.presentedRefreshToken) {
		await writeRefreshFamilyReplay(
			input.env,
			snapshot,
			await hashOAuthToken(input.presentedRefreshToken),
		)
	}
}

function canPersistRefreshFamily(env: Env) {
	return Boolean(env.BUNDLE_ARTIFACTS_KV && env.SECRET_STORE_KEY)
}

async function readGrantRefreshIds(
	env: Env,
	userId: string,
	grantId: string,
): Promise<RefreshFamilyGrantIds | null> {
	if (!env.OAUTH_KV) return null
	const grant = await env.OAUTH_KV.get<StoredGrantRecord>(
		`grant:${userId}:${grantId}`,
		{ type: 'json' },
	)
	if (!grant) return null
	return {
		currentRefreshTokenHash:
			typeof grant.refreshTokenId === 'string'
				? grant.refreshTokenId
				: undefined,
		previousRefreshTokenHash:
			typeof grant.previousRefreshTokenId === 'string'
				? grant.previousRefreshTokenId
				: undefined,
	}
}

async function readRefreshFamilySnapshot(
	env: Env,
	userId: string,
	grantId: string,
) {
	return readRefreshFamilySnapshotAtKey(
		env,
		mcpOAuthRefreshFamilySnapshotKey(userId, grantId),
		{ userId, grantId },
	)
}

async function readRefreshFamilySnapshotAtKey(
	env: Env,
	key: string,
	expected: { userId: string; grantId: string },
) {
	if (!canPersistRefreshFamily(env)) return null
	const ciphertext = await env.BUNDLE_ARTIFACTS_KV.get(key)
	if (!ciphertext) return null
	try {
		const parsed = JSON.parse(
			await decryptSecretValue(
				env,
				ciphertext,
				refreshFamilySecretContext(expected.userId, expected.grantId),
			),
		) as Partial<RefreshFamilySnapshot>
		if (
			parsed.userId !== expected.userId ||
			parsed.grantId !== expected.grantId ||
			typeof parsed.currentRefreshTokenHash !== 'string' ||
			typeof parsed.refreshToken !== 'string' ||
			typeof parsed.accessToken !== 'string' ||
			typeof parsed.accessExpiresAt !== 'number' ||
			typeof parsed.tokenType !== 'string' ||
			typeof parsed.scope !== 'string'
		) {
			return null
		}
		return {
			userId: parsed.userId,
			grantId: parsed.grantId,
			currentRefreshTokenHash: parsed.currentRefreshTokenHash,
			refreshToken: parsed.refreshToken,
			accessToken: parsed.accessToken,
			accessExpiresAt: parsed.accessExpiresAt,
			tokenType: parsed.tokenType,
			scope: parsed.scope,
			resource:
				typeof parsed.resource === 'string' ? parsed.resource : undefined,
		} satisfies RefreshFamilySnapshot
	} catch {
		return null
	}
}

async function writeRefreshFamilySnapshot(
	env: Env,
	snapshot: RefreshFamilySnapshot,
) {
	if (!canPersistRefreshFamily(env)) return
	const ciphertext = await encryptSecretValue(
		env,
		JSON.stringify(snapshot),
		refreshFamilySecretContext(snapshot.userId, snapshot.grantId),
	)
	await env.BUNDLE_ARTIFACTS_KV.put(
		mcpOAuthRefreshFamilySnapshotKey(snapshot.userId, snapshot.grantId),
		ciphertext,
		{ expirationTtl: mcpOAuthRefreshFamilySnapshotTtlSeconds },
	)
}

async function writeRefreshFamilyReplay(
	env: Env,
	snapshot: RefreshFamilySnapshot,
	tokenHash: string,
) {
	if (!canPersistRefreshFamily(env)) return
	const ciphertext = await encryptSecretValue(
		env,
		JSON.stringify(snapshot),
		refreshFamilySecretContext(snapshot.userId, snapshot.grantId),
	)
	await env.BUNDLE_ARTIFACTS_KV.put(
		mcpOAuthRefreshFamilyReplayKey(
			snapshot.userId,
			snapshot.grantId,
			tokenHash,
		),
		ciphertext,
		{ expirationTtl: mcpOAuthRefreshFamilyReplayTtlSeconds },
	)
}

function refreshFamilySecretContext(userId: string, grantId: string) {
	return `mcp-oauth-refresh-family:${userId}:${grantId}`
}

function createFamilyTokenResponse(snapshot: RefreshFamilySnapshot) {
	const expiresIn = Math.max(
		0,
		snapshot.accessExpiresAt - Math.floor(Date.now() / 1000),
	)
	const body: Record<string, string | number> = {
		access_token: snapshot.accessToken,
		token_type: snapshot.tokenType,
		expires_in: expiresIn,
		refresh_token: snapshot.refreshToken,
		scope: snapshot.scope,
	}
	if (snapshot.resource) {
		body.resource = snapshot.resource
	}
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			Pragma: 'no-cache',
		},
	})
}

function addOAuthTokenCorsHeaders(response: Response, request: Request) {
	const origin = request.headers.get('Origin')
	if (!origin) return response
	const headers = new Headers(response.headers)
	headers.set('Access-Control-Allow-Origin', origin)
	headers.set('Access-Control-Allow-Methods', '*')
	headers.set('Access-Control-Allow-Headers', 'Authorization, *')
	const exposedHeaders = (headers.get('Access-Control-Expose-Headers') ?? '')
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean)
	for (const requiredHeader of ['WWW-Authenticate', 'Retry-After']) {
		if (
			!exposedHeaders.some(
				(name) => name.toLowerCase() === requiredHeader.toLowerCase(),
			)
		) {
			exposedHeaders.push(requiredHeader)
		}
	}
	headers.set('Access-Control-Expose-Headers', exposedHeaders.join(', '))
	headers.set('Access-Control-Max-Age', '86400')
	const vary = headers.get('Vary')
	headers.set('Vary', vary ? `${vary}, Origin` : 'Origin')
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}
