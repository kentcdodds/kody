import { type EntityKind } from './types.ts'

export type ArtifactToken = {
	id: string
	plaintext: string
	scope: string
	expiresAt: string
}

export type ArtifactRepoInfo = {
	id: string
	name: string
	description: string | null
	defaultBranch: string
	createdAt: string
	updatedAt: string
	lastPushAt: string | null
	source: string | null
	readOnly: boolean
	remote: string
}

export type ArtifactRepoHandle = {
	info(): Promise<ArtifactRepoInfo | null>
	createToken(scope?: 'write' | 'read', ttl?: number): Promise<ArtifactToken>
	fork(target: {
		name: string
		namespace?: string
		readOnly?: boolean
	}): Promise<{
		id: string
		name: string
		description: string | null
		defaultBranch: string
		remote: string
		token: string
		expiresAt: string
		repo: ArtifactRepoHandle
	}>
}

export type ArtifactGetRepoResult =
	| { status: 'ready'; repo: ArtifactRepoHandle }
	| { status: 'not_found' }
	| { status: 'importing'; retryAfter: number }
	| { status: 'forking'; retryAfter: number }

export type ArtifactNamespaceBinding = {
	create(
		name: string,
		opts?: { readOnly?: boolean },
	): Promise<{
		id: string
		name: string
		description: string | null
		defaultBranch: string
		remote: string
		token: string
		expiresAt: string
	}>
	get(name: string): Promise<ArtifactGetRepoResult>
	list(opts?: { limit?: number; cursor?: string }): Promise<{
		repos: Array<Omit<ArtifactRepoInfo, 'remote'>>
		total: number
		cursor?: string
	}>
}

export function getArtifactsBinding(
	env: Env,
): ArtifactNamespaceBinding & Record<string, unknown> {
	const binding = (env as Env & { ARTIFACTS?: ArtifactNamespaceBinding })
		.ARTIFACTS
	if (!binding) {
		throw new Error('ARTIFACTS binding is not configured.')
	}
	return binding
}

export function getArtifactsNamespace(env: Env) {
	return (
		(env as Env & { ARTIFACTS_NAMESPACE?: string | undefined })
			.ARTIFACTS_NAMESPACE ?? 'default'
	)
}

function normalizeRepoNamePart(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
}

function trimRepoName(value: string) {
	return value.slice(0, 63).replace(/-+$/g, '')
}

export function buildEntityRepoId(input: {
	entityKind: EntityKind
	entityId: string
}) {
	return trimRepoName(
		normalizeRepoNamePart(`${input.entityKind}-${input.entityId}`),
	)
}

export function buildSessionRepoId(input: {
	entityKind: EntityKind
	entityId: string
	sessionId: string
}) {
	return trimRepoName(
		normalizeRepoNamePart(
			`${input.entityKind}-${input.entityId}-session-${input.sessionId}`,
		),
	)
}

export function parseArtifactTokenSecret(token: string) {
	return token.split('?expires=')[0] ?? token
}

export function buildAuthenticatedArtifactsRemote(input: {
	remote: string
	token: string
}) {
	const tokenSecret = parseArtifactTokenSecret(input.token)
	return `https://x:${tokenSecret}@${input.remote.slice('https://'.length)}`
}

export async function resolveArtifactSourceRepo(env: Env, repoId: string) {
	const binding = getArtifactsBinding(env)
	const result = await binding.get(repoId)
	if (result.status !== 'ready') {
		throw new Error(
			`Artifacts repo "${repoId}" is ${result.status}${
				'retryAfter' in result ? ` (retry after ${result.retryAfter}s)` : ''
			}.`,
		)
	}
	return result.repo
}

export async function resolveSessionRepo(
	env: Env,
	input: { namespace?: string | null; name: string },
) {
	const binding = getArtifactsBinding(env)
	void input.namespace
	const result = await binding.get(input.name)
	if (result.status !== 'ready') {
		throw new Error(
			`Artifacts repo "${input.name}" is ${result.status}${
				'retryAfter' in result ? ` (retry after ${result.retryAfter}s)` : ''
			}.`,
		)
	}
	return result.repo
}
