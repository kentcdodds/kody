import { toHex } from '@kody-internal/shared/hex.ts'
import { deleteValue, getValue, saveValue } from './service.ts'

export const skillRunnerTokensValueName = 'skillRunnerTokens'

const skillRunnerTokenBytes = 24
const skillRunnerTokenPrefix = 'tok_'
const skillRunnerTokenHashPrefix = 'sha256:'
const redactedTokenValue = 'tok_…'

export type SkillRunnerTokenRecord = {
	token: string
	name: string
	description: string
	lastUsedAt: string | null
}

export type SkillRunnerTokenStore = Record<string, SkillRunnerTokenRecord>

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeTokenRecord(
	clientName: string,
	raw: unknown,
): SkillRunnerTokenRecord | null {
	if (typeof raw === 'string') {
		const token = raw.trim()
		if (!token) return null
		return {
			token,
			name: clientName,
			description: '',
			lastUsedAt: null,
		}
	}
	if (!isRecord(raw)) return null
	const token = typeof raw['token'] === 'string' ? raw['token'].trim() : ''
	if (!token) return null
	const name =
		typeof raw['name'] === 'string' && raw['name'].trim().length > 0
			? raw['name'].trim()
			: clientName
	const description =
		typeof raw['description'] === 'string' ? raw['description'].trim() : ''
	const lastUsedAt =
		typeof raw['lastUsedAt'] === 'string' && raw['lastUsedAt'].trim().length > 0
			? raw['lastUsedAt'].trim()
			: null
	return {
		token,
		name,
		description,
		lastUsedAt,
	}
}

function normalizeTokenStore(raw: unknown) {
	if (!isRecord(raw)) {
		throw new Error(
			'Persisted skillRunnerTokens value must be a JSON object of clientName to token.',
		)
	}

	const entries = Object.entries(raw)
		.flatMap(([clientName, rawRecord]) => {
			const normalizedClientName = clientName.trim()
			if (!normalizedClientName) return []
			const normalizedRecord = normalizeTokenRecord(
				normalizedClientName,
				rawRecord,
			)
			return normalizedRecord == null
				? []
				: [[normalizedClientName, normalizedRecord] as const]
		})
		.sort(([left], [right]) => left.localeCompare(right))

	return Object.fromEntries(entries) satisfies SkillRunnerTokenStore
}

function parseTokenStore(rawValue: string | null): SkillRunnerTokenStore {
	if (!rawValue) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(rawValue)
	} catch {
		throw new Error(
			'Persisted skillRunnerTokens value must be valid JSON containing client tokens.',
		)
	}
	return normalizeTokenStore(parsed)
}

function tryParseTokenStore(
	rawValue: string | null,
): SkillRunnerTokenStore | null {
	try {
		return parseTokenStore(rawValue)
	} catch {
		return null
	}
}

function createStorageContext() {
	return {
		sessionId: null,
		appId: null,
		storageId: null,
	}
}

function generateSkillRunnerToken() {
	const bytes = new Uint8Array(skillRunnerTokenBytes)
	crypto.getRandomValues(bytes)
	return `${skillRunnerTokenPrefix}${toHex(bytes)}`
}

function maskToken(_token: string) {
	return redactedTokenValue
}

async function hashSkillRunnerToken(token: string) {
	const encoder = new TextEncoder()
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token))
	return `${skillRunnerTokenHashPrefix}${toHex(new Uint8Array(digest))}`
}

function isHashedToken(token: string) {
	return token.startsWith(skillRunnerTokenHashPrefix)
}

function padToLength(buffer: Uint8Array, length: number) {
	if (buffer.length === length) return buffer
	const padded = new Uint8Array(length)
	padded.set(buffer)
	return padded
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
	const maxLength = Math.max(left.length, right.length)
	const leftPadded = padToLength(left, maxLength)
	const rightPadded = padToLength(right, maxLength)
	const subtle = crypto.subtle as SubtleCrypto & {
		timingSafeEqual?: (
			a: ArrayBuffer | ArrayBufferView,
			b: ArrayBuffer | ArrayBufferView,
		) => boolean
	}
	const isEqual =
		typeof subtle.timingSafeEqual === 'function'
			? subtle.timingSafeEqual(leftPadded, rightPadded)
			: (() => {
					let result = 0
					for (let index = 0; index < maxLength; index += 1) {
						const leftValue = leftPadded[index] ?? 0
						const rightValue = rightPadded[index] ?? 0
						result |= leftValue ^ rightValue
					}
					return result === 0
				})()
	return isEqual && left.length === right.length
}

async function matchesToken(candidateToken: string, token: string) {
	const encoder = new TextEncoder()
	const tokenBytes = encoder.encode(token)
	const hashedToken = await hashSkillRunnerToken(token)
	const hashedBytes = encoder.encode(hashedToken)
	const candidateBytes = encoder.encode(candidateToken)
	return isHashedToken(candidateToken)
		? timingSafeEqual(hashedBytes, candidateBytes)
		: timingSafeEqual(tokenBytes, candidateBytes)
}

async function readTokenValue(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}) {
	const value = await getValue({
		env: input.env,
		userId: input.userId,
		name: skillRunnerTokensValueName,
		scope: 'user',
		storageContext: createStorageContext(),
	})
	return value?.value ?? null
}

async function writeSkillRunnerTokens(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	tokens: SkillRunnerTokenStore
}) {
	// This store mixes low-frequency admin updates with best-effort usage stamps.
	// Under concurrent writes, the value store's normal last-write-wins behavior
	// applies; occasional stale lastUsedAt metadata is acceptable here.
	await saveValue({
		env: input.env,
		userId: input.userId,
		name: skillRunnerTokensValueName,
		value: JSON.stringify(input.tokens),
		scope: 'user',
		description: 'External skill runner bearer tokens by client name',
		storageContext: createStorageContext(),
	})
}

export async function getSkillRunnerTokens(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}) {
	return parseTokenStore(await readTokenValue(input))
}

export async function createSkillRunnerToken(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	clientName: string
	name: string
	description?: string | null
}) {
	const clientName = input.clientName.trim()
	if (!clientName) {
		throw new Error('clientName is required.')
	}
	const name = input.name.trim()
	if (!name) {
		throw new Error('name is required.')
	}

	const tokens = await getSkillRunnerTokens(input)
	const existing = tokens[clientName]
	const token = generateSkillRunnerToken()
	tokens[clientName] = {
		token: await hashSkillRunnerToken(token),
		name,
		description: input.description?.trim() ?? existing?.description ?? '',
		lastUsedAt: existing?.lastUsedAt ?? null,
	}
	await writeSkillRunnerTokens({
		env: input.env,
		userId: input.userId,
		tokens,
	})
	return {
		...tokens[clientName],
		token,
	}
}

export async function revokeSkillRunnerToken(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	clientName: string
}) {
	const clientName = input.clientName.trim()
	if (!clientName) {
		throw new Error('clientName is required.')
	}

	const tokens = await getSkillRunnerTokens(input)
	const existed = Object.hasOwn(tokens, clientName)
	if (!existed) return false

	delete tokens[clientName]
	if (Object.keys(tokens).length === 0) {
		await deleteValue({
			env: input.env,
			userId: input.userId,
			name: skillRunnerTokensValueName,
			scope: 'user',
			storageContext: createStorageContext(),
		})
		return true
	}

	await writeSkillRunnerTokens({
		env: input.env,
		userId: input.userId,
		tokens,
	})
	return true
}

export async function listSkillRunnerTokens(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}) {
	const tokens = await getSkillRunnerTokens(input)
	return Object.entries(tokens)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([clientName, record]) => ({
			clientName,
			name: record.name,
			description: record.description || null,
			lastUsedAt: record.lastUsedAt,
			token: maskToken(record.token),
		}))
}

export async function resolveSkillRunnerUserByToken(input: {
	env: Pick<Env, 'APP_DB'>
	token: string
}) {
	const token = input.token.trim()
	if (!token) return null

	const now = new Date().toISOString()
	const { results } = await input.env.APP_DB.prepare(
		`SELECT vb.user_id, ve.value
			FROM value_entries ve
			INNER JOIN value_buckets vb ON vb.id = ve.bucket_id
			WHERE ve.name = ?
				AND vb.scope = 'user'
				AND vb.binding_key = ''
				AND (vb.expires_at IS NULL OR vb.expires_at > ?)`,
	)
		.bind(skillRunnerTokensValueName, now)
		.all<Record<string, unknown>>()

	for (const row of results ?? []) {
		const userId =
			typeof row['user_id'] === 'string' ? row['user_id'].trim() : ''
		const rawValue = typeof row['value'] === 'string' ? row['value'] : null
		if (!userId || !rawValue) continue
		const tokenStore = tryParseTokenStore(rawValue)
		if (!tokenStore) continue
		for (const [clientName, record] of Object.entries(tokenStore)) {
			if (await matchesToken(record.token, token)) {
				return { userId, clientName }
			}
		}
	}

	return null
}

export async function markSkillRunnerTokenUsed(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	clientName: string
}) {
	const tokens = await getSkillRunnerTokens(input)
	const existing = tokens[input.clientName]
	if (!existing) return false
	tokens[input.clientName] = {
		...existing,
		lastUsedAt: new Date().toISOString(),
	}
	await writeSkillRunnerTokens({
		env: input.env,
		userId: input.userId,
		tokens,
	})
	return true
}
