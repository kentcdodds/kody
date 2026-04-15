import { toHex } from '@kody-internal/shared/hex.ts'
import { deleteValue, getValue, saveValue } from './service.ts'

export const skillRunnerTokensValueName = 'skillRunnerTokens'

const skillRunnerTokenBytes = 24
const skillRunnerTokenPrefix = 'tok_'
const redactedTokenValue = 'tok_…'

export type SkillRunnerTokenMap = Record<string, string>

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeTokenMap(raw: unknown) {
	if (!isRecord(raw)) {
		throw new Error(
			'Persisted skillRunnerTokens value must be a JSON object of clientName to token.',
		)
	}

	const entries = Object.entries(raw)
		.filter(([clientName, token]) => {
			return clientName.trim().length > 0 && typeof token === 'string'
		})
		.map(([clientName, token]) => [clientName.trim(), token.trim()] as const)
		.filter(([, token]) => token.length > 0)
		.sort(([left], [right]) => left.localeCompare(right))

	return Object.fromEntries(entries) satisfies SkillRunnerTokenMap
}

function parseTokenMap(rawValue: string | null): SkillRunnerTokenMap {
	if (!rawValue) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(rawValue)
	} catch {
		throw new Error(
			'Persisted skillRunnerTokens value must be valid JSON containing client tokens.',
		)
	}
	return normalizeTokenMap(parsed)
}

function tryParseTokenMap(rawValue: string | null): SkillRunnerTokenMap | null {
	try {
		return parseTokenMap(rawValue)
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

export async function getSkillRunnerTokens(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}) {
	return parseTokenMap(await readTokenValue(input))
}

export async function createSkillRunnerToken(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	clientName: string
}) {
	const clientName = input.clientName.trim()
	if (!clientName) {
		throw new Error('clientName is required.')
	}

	const tokens = await getSkillRunnerTokens(input)
	const token = generateSkillRunnerToken()
	tokens[clientName] = token
	await saveValue({
		env: input.env,
		userId: input.userId,
		name: skillRunnerTokensValueName,
		value: JSON.stringify(tokens),
		scope: 'user',
		description: 'External skill runner bearer tokens by client name',
		storageContext: createStorageContext(),
	})
	return token
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

	await saveValue({
		env: input.env,
		userId: input.userId,
		name: skillRunnerTokensValueName,
		value: JSON.stringify(tokens),
		scope: 'user',
		description: 'External skill runner bearer tokens by client name',
		storageContext: createStorageContext(),
	})
	return true
}

export async function listSkillRunnerTokens(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}) {
	const tokens = await getSkillRunnerTokens(input)
	return Object.fromEntries(
		Object.keys(tokens)
			.sort((left, right) => left.localeCompare(right))
			.map((clientName) => [clientName, maskToken(tokens[clientName] ?? '')]),
	) satisfies SkillRunnerTokenMap
}

export async function resolveSkillRunnerUserByToken(input: {
	env: Pick<Env, 'APP_DB'>
	token: string
}) {
	const token = input.token.trim()
	if (!token) return null

	const now = new Date().toISOString()
	const { results } = await input.env.APP_DB
		.prepare(
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
		const rawValue =
			typeof row['value'] === 'string' ? row['value'] : null
		if (!userId || !rawValue) continue
		const tokenMap = tryParseTokenMap(rawValue)
		if (!tokenMap) continue
		if (Object.values(tokenMap).includes(token)) {
			return { userId }
		}
	}

	return null
}
