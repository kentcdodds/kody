import {
	packageSkillsIndexVersion,
	type PackageSkillsIndex,
} from './package-skills.ts'

const skillsIndexCachePrefix = 'package-skills-index'

function getSkillsKv(env: Env) {
	const kv = (env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace })
		.BUNDLE_ARTIFACTS_KV
	if (!kv) {
		throw new Error('Missing BUNDLE_ARTIFACTS_KV binding for package skills.')
	}
	return kv
}

export function hasPackageSkillsKv(env: Env) {
	return (
		(env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace | undefined })
			.BUNDLE_ARTIFACTS_KV != null
	)
}

export function buildPackageSkillsIndexKey(input: {
	userId: string
	packageId: string
	publishedCommit: string
}) {
	return [
		skillsIndexCachePrefix,
		`v${packageSkillsIndexVersion}`,
		input.userId,
		input.packageId,
		input.publishedCommit,
	].join(':')
}

function buildPackageSkillsIndexPrefix(input: {
	userId: string
	packageId: string
}) {
	return (
		[
			skillsIndexCachePrefix,
			`v${packageSkillsIndexVersion}`,
			input.userId,
			input.packageId,
		].join(':') + ':'
	)
}

function isPackageSkillsIndex(value: unknown): value is PackageSkillsIndex {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { version?: unknown }).version === packageSkillsIndexVersion &&
		typeof (value as { packageId?: unknown }).packageId === 'string' &&
		typeof (value as { publishedCommit?: unknown }).publishedCommit ===
			'string' &&
		Array.isArray((value as { skills?: unknown }).skills)
	)
}

async function listPackageSkillsIndexKeys(input: {
	kv: KVNamespace
	prefix: string
}) {
	const keys: Array<string> = []
	let cursor: string | undefined
	do {
		const result = await input.kv.list({ prefix: input.prefix, cursor })
		keys.push(...result.keys.map((key) => key.name))
		cursor = result.list_complete ? undefined : result.cursor
	} while (cursor)
	return keys
}

/**
 * Writes the index for one package version. An index with an empty `skills`
 * array is a definitive "this version ships no skills" answer.
 */
export async function writePackageSkillsIndex(input: {
	env: Env
	userId: string
	index: PackageSkillsIndex
}) {
	await getSkillsKv(input.env).put(
		buildPackageSkillsIndexKey({
			userId: input.userId,
			packageId: input.index.packageId,
			publishedCommit: input.index.publishedCommit,
		}),
		JSON.stringify(input.index),
	)
}

/** Returns `null` when KV is unbound, the key is missing, or the value is malformed. */
export async function readPackageSkillsIndex(input: {
	env: Env
	userId: string
	packageId: string
	publishedCommit: string
}): Promise<PackageSkillsIndex | null> {
	if (!hasPackageSkillsKv(input.env)) return null
	const stored = await getSkillsKv(input.env).get(
		buildPackageSkillsIndexKey(input),
		'json',
	)
	if (!isPackageSkillsIndex(stored)) return null
	if (
		stored.packageId !== input.packageId ||
		stored.publishedCommit !== input.publishedCommit
	) {
		return null
	}
	return stored
}

/** Deletes the indexes for every published commit of one package. */
export async function removePackageSkillsIndexEntries(input: {
	env: Env
	userId: string
	packageId: string
}) {
	if (!hasPackageSkillsKv(input.env)) return
	const kv = getSkillsKv(input.env)
	const keys = await listPackageSkillsIndexKeys({
		kv,
		prefix: buildPackageSkillsIndexPrefix(input),
	})
	await Promise.all(keys.map(async (key) => await kv.delete(key)))
}

/** Deletes every package skills index owned by a user (account deletion). */
export async function deleteAllPackageSkillsIndexEntriesForUser(input: {
	env: Env
	userId: string
}) {
	if (!hasPackageSkillsKv(input.env)) return 0
	const kv = getSkillsKv(input.env)
	const prefix = `${skillsIndexCachePrefix}:v${packageSkillsIndexVersion}:${input.userId}:`
	const keys = await listPackageSkillsIndexKeys({ kv, prefix })
	const outOfScope = keys.find((key) => !key.startsWith(prefix))
	if (outOfScope) {
		throw new Error(
			`Package skills KV listing returned out-of-scope key: ${outOfScope}`,
		)
	}
	await Promise.all(keys.map(async (key) => await kv.delete(key)))
	return keys.length
}
