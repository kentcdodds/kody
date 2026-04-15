import { toHex } from '@kody-internal/shared/hex.ts'
import {
	decryptSecretValue,
	encryptSecretValue,
} from '#mcp/secrets/crypto.ts'
import {
	buildSkillRunnerSecretName,
	parseSkillRunnerSecretClientName,
	skillRunnerSecretNamePrefix,
} from '#mcp/secrets/name-guards.ts'
import {
	deleteSecretEntry,
	getSecretBucket,
	upsertSecretBucket,
} from '#mcp/secrets/repo.ts'

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

type StoredSkillRunnerTokenRecord = {
	tokenHash: string
	name: string
	description: string
	lastUsedAt: string | null
}

type SkillRunnerSecretEntry = {
	name: string
	description: string
	encrypted_value: string
	created_at: string
	updated_at: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
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

function normalizeStoredSkillRunnerTokenRecord(
	clientName: string,
	raw: unknown,
): StoredSkillRunnerTokenRecord {
	if (!isRecord(raw)) {
		throw new Error(
			`Stored skill runner token metadata for "${clientName}" must be a JSON object.`,
		)
	}
	const tokenHash =
		typeof raw['tokenHash'] === 'string' ? raw['tokenHash'].trim() : ''
	if (!tokenHash) {
		throw new Error(
			`Stored skill runner token metadata for "${clientName}" is missing tokenHash.`,
		)
	}
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
		tokenHash,
		name,
		description,
		lastUsedAt,
	}
}

async function readStoredSkillRunnerTokenRecord(input: {
	env: Pick<Env, 'COOKIE_SECRET'>
	clientName: string
	entry: SkillRunnerSecretEntry
}) {
	const decrypted = await decryptSecretValue(input.env, input.entry.encrypted_value)
	let parsed: unknown
	try {
		parsed = JSON.parse(decrypted)
	} catch {
		throw new Error(
			`Stored skill runner token metadata for "${input.clientName}" must be valid JSON.`,
		)
	}
	return normalizeStoredSkillRunnerTokenRecord(input.clientName, parsed)
}

async function getUserSecretBucket(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}) {
	return getSecretBucket({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: 'user',
		bindingKey: '',
	})
}

async function getOrCreateUserSecretBucket(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}) {
	const existing = await getUserSecretBucket(input)
	if (existing) return existing
	const now = new Date().toISOString()
	const created = {
		id: crypto.randomUUID(),
		user_id: input.userId,
		scope: 'user' as const,
		binding_key: '',
		expires_at: null,
		created_at: now,
		updated_at: now,
	}
	await upsertSecretBucket({
		db: input.env.APP_DB,
		row: created,
	})
	return created
}

async function getSkillRunnerSecretEntry(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	clientName: string
}) {
	const bucket = await getUserSecretBucket(input)
	if (!bucket) return null
	return input.env.APP_DB
		.prepare(
			`SELECT name, description, encrypted_value, created_at, updated_at
			FROM secret_entries
			WHERE bucket_id = ? AND name = ?
			LIMIT 1`,
		)
		.bind(bucket.id, buildSkillRunnerSecretName(input.clientName))
		.first<SkillRunnerSecretEntry>()
}

async function listSkillRunnerSecretEntries(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}) {
	const bucket = await getUserSecretBucket(input)
	if (!bucket) return []
	const { results } = await input.env.APP_DB
		.prepare(
			`SELECT name, description, encrypted_value, created_at, updated_at
			FROM secret_entries
			WHERE bucket_id = ? AND name LIKE ?
			ORDER BY name ASC`,
		)
		.bind(bucket.id, `${skillRunnerSecretNamePrefix}%`)
		.all<SkillRunnerSecretEntry>()
	return results ?? []
}

async function upsertSkillRunnerSecretEntry(input: {
	env: Pick<Env, 'APP_DB' | 'COOKIE_SECRET'>
	userId: string
	clientName: string
	record: StoredSkillRunnerTokenRecord
}) {
	const bucket = await getOrCreateUserSecretBucket(input)
	const encryptedValue = await encryptSecretValue(
		input.env,
		JSON.stringify(input.record),
	)
	const now = new Date().toISOString()
	await input.env.APP_DB.prepare(
		`INSERT INTO secret_entries (
			bucket_id, name, description, encrypted_value, allowed_hosts,
			allowed_capabilities, lookup_hash, created_at, updated_at
		) VALUES (?, ?, ?, ?, '[]', '[]', ?, ?, ?)
		ON CONFLICT(bucket_id, name)
		DO UPDATE SET
			description = excluded.description,
			encrypted_value = excluded.encrypted_value,
			allowed_hosts = excluded.allowed_hosts,
			allowed_capabilities = excluded.allowed_capabilities,
			lookup_hash = excluded.lookup_hash,
			updated_at = excluded.updated_at`,
	)
		.bind(
			bucket.id,
			buildSkillRunnerSecretName(input.clientName),
			input.record.description,
			encryptedValue,
			input.record.tokenHash,
			now,
			now,
		)
		.run()
}

async function getSecretBackedSkillRunnerTokens(input: {
	env: Pick<Env, 'APP_DB' | 'COOKIE_SECRET'>
	userId: string
}) {
	const entries = await listSkillRunnerSecretEntries(input)
	const records = await Promise.all(
		entries.map(async (entry) => {
			const clientName = parseSkillRunnerSecretClientName(entry.name)
			if (!clientName) return null
			const record = await readStoredSkillRunnerTokenRecord({
				env: input.env,
				clientName,
				entry,
			})
			return [clientName, record] as const
		}),
	)
	return Object.fromEntries(
		records
			.filter((entry): entry is NonNullable<typeof entry> => entry != null)
			.sort(([left], [right]) => left.localeCompare(right)),
	)
}

export async function getSkillRunnerTokens(input: {
	env: Pick<Env, 'APP_DB' | 'COOKIE_SECRET'>
	userId: string
}) {
	const tokens = await getSecretBackedSkillRunnerTokens(input)
	return Object.fromEntries(
		Object.entries(tokens).map(([clientName, record]) => [
			clientName,
			{
				token: record.tokenHash,
				name: record.name,
				description: record.description,
				lastUsedAt: record.lastUsedAt,
			},
		]),
	) satisfies SkillRunnerTokenStore
}

export async function createSkillRunnerToken(input: {
	env: Pick<Env, 'APP_DB' | 'COOKIE_SECRET'>
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

	const existingEntry = await getSkillRunnerSecretEntry({
		env: input.env,
		userId: input.userId,
		clientName,
	})
	const existingRecord = existingEntry
		? await readStoredSkillRunnerTokenRecord({
				env: input.env,
				clientName,
				entry: existingEntry,
			})
		: null
	const token = generateSkillRunnerToken()
	const tokenHash = await hashSkillRunnerToken(token)
	await upsertSkillRunnerSecretEntry({
		env: input.env,
		userId: input.userId,
		clientName,
		record: {
			tokenHash,
			name,
			description: input.description?.trim() ?? existingRecord?.description ?? '',
			lastUsedAt: existingRecord?.lastUsedAt ?? null,
		},
	})
	return {
		token,
		name,
		description: input.description?.trim() ?? existingRecord?.description ?? '',
		lastUsedAt: existingRecord?.lastUsedAt ?? null,
	}
}

export async function revokeSkillRunnerToken(input: {
	env: Pick<Env, 'APP_DB' | 'COOKIE_SECRET'>
	userId: string
	clientName: string
}) {
	const clientName = input.clientName.trim()
	if (!clientName) {
		throw new Error('clientName is required.')
	}

	const bucket = await getUserSecretBucket(input)
	if (!bucket) return false
	return deleteSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name: buildSkillRunnerSecretName(clientName),
	})
}

export async function listSkillRunnerTokens(input: {
	env: Pick<Env, 'APP_DB' | 'COOKIE_SECRET'>
	userId: string
}) {
	const tokens = await getSecretBackedSkillRunnerTokens(input)
	return Object.entries(tokens)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([clientName, record]) => ({
			clientName,
			name: record.name,
			description: record.description || null,
			lastUsedAt: record.lastUsedAt,
			token: maskToken(record.tokenHash),
		}))
}

export async function resolveSkillRunnerUserByToken(input: {
	env: Pick<Env, 'APP_DB' | 'COOKIE_SECRET'>
	token: string
}) {
	const token = input.token.trim()
	if (!token) return null

	const lookupHash = await hashSkillRunnerToken(token)
	const now = new Date().toISOString()
	const row = await input.env.APP_DB.prepare(
		`SELECT sb.user_id, se.name
			FROM secret_entries se
			INNER JOIN secret_buckets sb ON sb.id = se.bucket_id
			WHERE se.lookup_hash = ?
				AND se.name LIKE ?
				AND sb.scope = 'user'
				AND sb.binding_key = ''
				AND (sb.expires_at IS NULL OR sb.expires_at > ?)
			LIMIT 1`,
	)
		.bind(lookupHash, `${skillRunnerSecretNamePrefix}%`, now)
		.first<Record<string, unknown>>()
	if (row) {
		const userId =
			typeof row['user_id'] === 'string' ? row['user_id'].trim() : ''
		const clientName =
			typeof row['name'] === 'string'
				? parseSkillRunnerSecretClientName(row['name'])
				: null
		if (userId && clientName) {
			return { userId, clientName }
		}
	}
	return null
}

export async function markSkillRunnerTokenUsed(input: {
	env: Pick<Env, 'APP_DB' | 'COOKIE_SECRET'>
	userId: string
	clientName: string
}) {
	const existingEntry = await getSkillRunnerSecretEntry({
		env: input.env,
		userId: input.userId,
		clientName: input.clientName,
	})
	if (existingEntry) {
		const existing = await readStoredSkillRunnerTokenRecord({
			env: input.env,
			clientName: input.clientName,
			entry: existingEntry,
		})
		await upsertSkillRunnerSecretEntry({
			env: input.env,
			userId: input.userId,
			clientName: input.clientName,
			record: {
				...existing,
				lastUsedAt: new Date().toISOString(),
			},
		})
		return true
	}
	return false
}
