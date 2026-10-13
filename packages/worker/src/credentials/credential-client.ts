/**
 * The host half of the `credential()` scoped client (ADR 0068).
 *
 * `openCredentialClient` resolves a need key (or an exact name) to one
 * credential the actor can Use and returns a signed, run-scoped handle with
 * the credential's name, scope, kind, and hosts. It reads no value. Every use
 * of the handle (a gateway fetch, `sign`, `callTool`, an OAuth refresh) goes
 * through `resolveCredential`, which authorizes and audits it again.
 *
 * Errors are structured: a `code` from the ADR's table and `retryWith`, a
 * list of ready-to-retry picks (empty when there is nothing to retry with).
 * No error carries a value, and option lists hold only credentials the actor
 * can Use.
 */
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpCallerError } from '#mcp/caller-error.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	isFetchCapableCredentialKind,
	type PackageCredentialKind,
} from '#worker/package-registry/types.ts'
import {
	CredentialClientHandleError,
	signCredentialClientHandle,
	verifyCredentialClientHandle,
} from './credential-client-handle.ts'
import {
	findCredentialById,
	listUsableCredentials,
	resolveNeedCandidates,
	type UsableCredential,
} from './credential-candidates.ts'
import {
	type CredentialCallMap,
	type CredentialPick,
} from './credential-call-map.ts'
import { loadPublishedCredentialNeeds } from './credential-needs-closure.ts'
import { type CredentialNeed } from './credential-needs.ts'
import {
	CredentialLoginFailedError,
	CredentialNotFoundError,
	CredentialRequestRefusedError,
} from './credential-request.ts'
import {
	type CredentialTarget,
	type ResolvedClientPlacement,
	type ResolveCredentialInput,
} from './credential-resolver.ts'
import { resolveCredential } from './resolve-credential.ts'
import { type SigningOperation } from './signing-resolver.ts'

export type CredentialClientErrorCode =
	| 'credential_unbound'
	| 'credential_ambiguous'
	| 'credential_not_found'
	| 'credential_denied'
	| 'credential_need_unknown'
	| 'host_not_allowed'
	| 'insecure_transport'
	| 'invalid_request'
	| 'login_failed'

export type CredentialClientOption = {
	name: string
	scope: UsableCredential['scope']
	kind: PackageCredentialKind
	hosts: Array<string>
}

/** One ready-to-retry pick: a call-map entry, or `credential.named`. */
export type CredentialClientRetry = {
	credentials?: Record<
		string,
		{ name: string; scope: UsableCredential['scope'] }
	>
	named?: { name: string; scope: UsableCredential['scope'] }
}

export type CredentialClientErrorBody = {
	code: CredentialClientErrorCode
	message: string
	retryWith: Array<CredentialClientRetry>
	options?: Array<CredentialClientOption>
	possibleMatches?: Array<CredentialClientOption>
}

export class CredentialClientError extends McpCallerError {
	readonly body: CredentialClientErrorBody
	constructor(body: CredentialClientErrorBody) {
		// The code leads the message so a fetch rejection, which carries only
		// the message, still says which error it is.
		super(`[${body.code}] ${body.message}`)
		this.name = 'CredentialClientError'
		this.body = body
	}
}

function refusal(
	code: CredentialClientErrorCode,
	message: string,
	extra: Partial<CredentialClientErrorBody> = {},
) {
	return new CredentialClientError({ code, message, retryWith: [], ...extra })
}

/** The structured error for a failure from the door, else null. */
export function toCredentialClientError(error: unknown) {
	if (error instanceof CredentialClientError) return error
	if (error instanceof CredentialRequestRefusedError) {
		return refusal(error.code, error.message)
	}
	if (error instanceof CredentialNotFoundError) {
		return refusal('credential_not_found', error.message)
	}
	if (error instanceof CredentialLoginFailedError) {
		return refusal('login_failed', error.message)
	}
	if (error instanceof CredentialClientHandleError) {
		return refusal('invalid_request', error.message)
	}
	if (error instanceof AuthorizationError) {
		return refusal('credential_denied', error.message)
	}
	return null
}

/** What every client call needs from the run. */
export type CredentialClientContext = {
	env: Env
	callerContext: McpCallerContext
	/** The run (or CapabilityProxy credential) handles are bound to. */
	binding: string
	/** The package whose needs and sharing apply, or null for ad hoc code. */
	packageId: string | null
	/** The caller's picks for this run, by need key. */
	callMap?: CredentialCallMap | null
	/**
	 * The run's pinned needs as `validateCredentialCallMap` sees them. When
	 * set, a key missing here reads as a provider: a package's latest publish
	 * never adds needs the run's entry closures did not pin.
	 */
	runNeeds?: () => Promise<ReadonlyMap<string, CredentialNeed>>
	waitUntil?: (promise: Promise<unknown>) => void
}

export type OpenedCredentialClient = {
	handle: string
	key: string | null
	name: string
	scope: UsableCredential['scope']
	kind: PackageCredentialKind
	hosts: Array<string>
	/** Set when an explicit pick has no provider and could resolve on its own. */
	hint?: string
}

type Picked = { credential: UsableCredential; hint: string | null }

/** What a need key asks for: the declared need, or the key read as a provider. */
type NeedTarget = {
	kind: PackageCredentialKind | null
	provider: string
	describe: string
	/**
	 * How an explicit pick's kind is checked: declared kind, any fetch-capable
	 * kind when the need omits kind, or any kind for an ad-hoc provider key.
	 */
	match: 'exact' | 'fetch-capable' | 'any'
}

const maxKeyLength = 100

function requireActorRequest(ctx: CredentialClientContext): RequestContext {
	const request = ctx.callerContext.request
	if (!request?.actor) {
		throw refusal(
			'credential_denied',
			'Credentials resolve only for a person. This run has no acting person.',
		)
	}
	return request
}

function readText(value: unknown, field: string) {
	const text = typeof value === 'string' ? value.trim() : ''
	if (!text || text.length > maxKeyLength) {
		throw refusal(
			'invalid_request',
			`${field} must be a non-empty string of at most ${maxKeyLength} characters.`,
		)
	}
	return text
}

function readScope(value: unknown): CredentialPick['scope'] {
	if (value == null) return null
	if (value === 'org' || value === 'personal') return value
	throw refusal('invalid_request', 'scope must be "org" or "personal".')
}

function toOption(credential: UsableCredential): CredentialClientOption {
	return {
		name: credential.name,
		scope: credential.scope,
		kind: credential.kind,
		hosts: credential.hosts,
	}
}

/** `"work" (org), "work" (personal)`: names and scopes to pick from. */
function describeOptions(credentials: ReadonlyArray<UsableCredential>) {
	return credentials
		.map((credential) => `"${credential.name}" (${credential.scope})`)
		.join(', ')
}

function retryFor(key: string | null, credential: UsableCredential) {
	const pick = { name: credential.name, scope: credential.scope }
	return {
		...(key ? { credentials: { [key]: pick } } : {}),
		named: pick,
	}
}

async function loadPackageNeeds(input: {
	env: Env
	request: RequestContext
	packageId: string
}) {
	const saved = await getSavedPackageById(input.env.APP_DB, {
		userId: input.request.org.id,
		packageId: input.packageId,
	})
	if (!saved) return []
	return await loadPublishedCredentialNeeds({
		env: input.env,
		userId: saved.userId,
		sourceId: saved.sourceId,
	})
}

async function loadNeed(ctx: CredentialClientContext, key: string) {
	if (ctx.runNeeds) return (await ctx.runNeeds()).get(key) ?? null
	if (!ctx.packageId) return null
	const needs = await loadPackageNeeds({
		env: ctx.env,
		request: requireActorRequest(ctx),
		packageId: ctx.packageId,
	})
	return needs.find((need) => need.key === key) ?? null
}

function needTarget(key: string, need: CredentialNeed | null): NeedTarget {
	if (!need) {
		return {
			kind: null,
			provider: key,
			describe: `provider "${key}"`,
			match: 'any',
		}
	}
	const provider = need.provider
	if (need.kind) {
		return {
			kind: need.kind,
			provider,
			describe: `need "${key}" (${need.kind} from provider "${provider}")`,
			match: 'exact',
		}
	}
	return {
		kind: null,
		provider,
		describe: `need "${key}" (any fetch-capable credential from provider "${provider}")`,
		match: 'fetch-capable',
	}
}

/**
 * `credential.named` works only in ad hoc code and in a package of the
 * actor's personal org that is not listed in Community.
 */
async function assertNamedAllowed(ctx: CredentialClientContext) {
	if (!ctx.packageId) return
	const request = requireActorRequest(ctx)
	const personal = request.org.id === personalOrgId(request.actor!.userId)
	const listed = personal
		? await ctx.env.APP_DB.prepare(
				`SELECT 1 AS listed FROM community_listings
				WHERE package_id = ? AND status = 'active' AND deleted_at IS NULL
				LIMIT 1`,
			)
				.bind(ctx.packageId)
				.first<{ listed: number }>()
		: null
	if (!personal || listed) {
		throw refusal(
			'credential_denied',
			'credential.named works only in ad hoc execute and in unshared packages of your personal org. Declare the credential in kody.credentials and call credential(key) instead.',
		)
	}
}

function pickOne(input: {
	key: string | null
	candidates: Array<UsableCredential>
	possibleMatches: Array<UsableCredential>
	describe: string
}) {
	const [only, second] = input.candidates
	if (only && !second) return only
	if (!only) {
		throw refusal(
			'credential_unbound',
			`No credential you can use matches ${input.describe}.${
				input.possibleMatches.length > 0
					? ' Some matching credentials have no provider; pick one by name, or set its provider with credentialUpdate so it resolves on its own.'
					: ''
			}`,
			{
				retryWith: input.possibleMatches.map((match) =>
					retryFor(input.key, match),
				),
				possibleMatches: input.possibleMatches.map(toOption),
			},
		)
	}
	throw refusal(
		'credential_ambiguous',
		`More than one credential you can use matches ${input.describe}: ${describeOptions(input.candidates)}. Pick one by name and scope.`,
		{
			retryWith: input.candidates.map((candidate) =>
				retryFor(input.key, candidate),
			),
			options: input.candidates.map(toOption),
		},
	)
}

function findByName(
	usable: ReadonlyArray<UsableCredential>,
	pick: CredentialPick,
	key: string | null,
) {
	const matches = usable.filter(
		(credential) =>
			credential.name === pick.name &&
			(!pick.scope || credential.scope === pick.scope),
	)
	if (matches.length === 0) {
		throw refusal(
			'credential_not_found',
			`No credential named "${pick.name}" that you can use${pick.scope ? ` in ${pick.scope} scope` : ''}.`,
		)
	}
	return pickOne({
		key,
		candidates: matches,
		possibleMatches: [],
		describe: `the name "${pick.name}"`,
	})
}

/**
 * An explicit call-map pick (resolution rule 2): the kind filter must match,
 * and the provider must match when both sides have one.
 */
function pickExplicit(input: {
	key: string
	pick: CredentialPick
	usable: ReadonlyArray<UsableCredential>
	target: NeedTarget
}): Picked {
	const credential = findByName(input.usable, input.pick, input.key)
	const { kind, provider, match } = input.target
	if (match === 'exact' && kind && credential.kind !== kind) {
		throw refusal(
			'invalid_request',
			`credentials.${input.key} picks "${credential.name}", a ${credential.kind} credential; this need takes a ${kind} credential.`,
		)
	}
	if (
		match === 'fetch-capable' &&
		!isFetchCapableCredentialKind(credential.kind)
	) {
		throw refusal(
			'invalid_request',
			`credentials.${input.key} picks "${credential.name}", a ${credential.kind} credential; this need takes any fetch-capable credential (secret, oauth, or login).`,
		)
	}
	if (credential.provider && credential.provider !== provider) {
		throw refusal(
			'invalid_request',
			`credentials.${input.key} picks "${credential.name}", whose provider is "${credential.provider}"; this need takes provider "${provider}".`,
		)
	}
	return {
		credential,
		hint: credential.provider
			? null
			: `"${credential.name}" has no provider. Set its provider to "${provider}" with credentialUpdate so it resolves without a pick.`,
	}
}

async function resolveKey(
	ctx: CredentialClientContext,
	key: string,
	usable: ReadonlyArray<UsableCredential>,
	mode: 'one' | 'many',
): Promise<Array<Picked>> {
	const need = await loadNeed(ctx, key)
	const target = needTarget(key, need)
	const picks = ctx.callMap?.get(key)
	if (!picks) {
		if (need) {
			const resolution = resolveNeedCandidates(need, usable)
			const credential = pickOne({
				key,
				candidates: resolution.candidates,
				possibleMatches: resolution.possibleMatches,
				describe: target.describe,
			})
			return [{ credential, hint: null }]
		}
		const credential = pickOne({
			key,
			candidates: usable.filter(
				(candidate) => candidate.provider === target.provider,
			),
			possibleMatches: [],
			describe: target.describe,
		})
		return [{ credential, hint: null }]
	}
	if (mode === 'one' && picks.length === 0) {
		throw refusal(
			'credential_unbound',
			`The credentials map picks no credential for "${key}".`,
		)
	}
	const picked = new Map<string, Picked>()
	for (const pick of picks) {
		const one = pickExplicit({ key, pick, usable, target })
		picked.set(one.credential.id, one)
	}
	const all = [...picked.values()].map((one) => one.credential)
	if (mode === 'one' && all.length > 1) {
		throw refusal(
			'invalid_request',
			`The credentials map picks ${all.length} credentials for "${key}": ${describeOptions(all)}. Pick one of them for credential("${key}"), or call credentials("${key}") to get all of them.`,
			{
				retryWith: all.map((credential) => retryFor(key, credential)),
				options: all.map(toOption),
			},
		)
	}
	return [...picked.values()]
}

async function issueClient(
	ctx: CredentialClientContext,
	key: string | null,
	{ credential: picked, hint }: Picked,
): Promise<OpenedCredentialClient> {
	const request = requireActorRequest(ctx)
	if (picked.kind === 'mcp' && picked.scope === 'personal') {
		throw refusal(
			'credential_denied',
			'A personal MCP server cannot be used through credential() yet. Connect it in the org instead.',
		)
	}
	const handle = await signCredentialClientHandle({
		env: ctx.env,
		handle: {
			id: picked.id,
			kind: picked.kind,
			name: picked.name,
			scope: picked.scope,
			org: request.org.id,
			actor: request.actor!.userId,
			binding: ctx.binding,
		},
	})
	return {
		handle,
		key,
		name: picked.name,
		scope: picked.scope,
		kind: picked.kind,
		hosts: picked.hosts,
		...(hint ? { hint } : {}),
	}
}

export async function openCredentialClient(
	ctx: CredentialClientContext,
	input: { key?: unknown; name?: unknown; scope?: unknown },
): Promise<OpenedCredentialClient> {
	const request = requireActorRequest(ctx)
	const usable = await listUsableCredentials({ env: ctx.env, request })
	if (input.name != null) {
		await assertNamedAllowed(ctx)
		const pick = {
			name: readText(input.name, 'A credential name'),
			scope: readScope(input.scope),
		}
		return await issueClient(ctx, null, {
			credential: findByName(usable, pick, null),
			hint: null,
		})
	}
	const key = readText(input.key, 'A credential key')
	const [picked] = await resolveKey(ctx, key, usable, 'one')
	return await issueClient(ctx, key, picked!)
}

/**
 * `credentials(key)`: every pick the call map gives for the key, or the one
 * candidate when it gives none (a `multiple` need never gets "all of them").
 */
export async function openCredentialClients(
	ctx: CredentialClientContext,
	input: { key?: unknown },
): Promise<Array<OpenedCredentialClient>> {
	const request = requireActorRequest(ctx)
	const key = readText(input.key, 'A credential key')
	const usable = await listUsableCredentials({ env: ctx.env, request })
	const picked = await resolveKey(ctx, key, usable, 'many')
	return await Promise.all(picked.map((one) => issueClient(ctx, key, one)))
}

/**
 * Every need the run's entry packages declare, by key, first entry wins.
 * Pass entries only (see `credentialNeedsEntryPackageIds`): an entry's
 * closure pins its static dependencies' needs, so a dependency's later
 * publish never adds or replaces them.
 */
export async function loadRunCredentialNeeds(input: {
	env: Env
	request: RequestContext
	packageIds: ReadonlyArray<string>
}): Promise<ReadonlyMap<string, CredentialNeed>> {
	const needLists = await Promise.all(
		input.packageIds.map((packageId) =>
			loadPackageNeeds({ env: input.env, request: input.request, packageId }),
		),
	)
	const needs = new Map<string, CredentialNeed>()
	for (const need of needLists.flat()) {
		if (!needs.has(need.key)) needs.set(need.key, need)
	}
	return needs
}

/**
 * Validates a call map before code runs (resolution rule 4). Every pick must
 * resolve. A key no package in the run declares is an error when `strict`
 * (an invoke) and a warning otherwise (ad hoc code reads it as a provider).
 */
export async function validateCredentialCallMap(input: {
	env: Env
	request: RequestContext | null
	map: CredentialCallMap
	packageIds: ReadonlyArray<string>
	strict: boolean
}): Promise<{ warnings: Array<string> }> {
	return await withClientErrors(async () => {
		const request = input.request
		if (!request?.actor) {
			throw refusal(
				'credential_denied',
				'A credentials map needs a person. This run has no acting person.',
			)
		}
		const [usable, needs] = await Promise.all([
			listUsableCredentials({ env: input.env, request }),
			loadRunCredentialNeeds({
				env: input.env,
				request,
				packageIds: input.packageIds,
			}),
		])
		const warnings: Array<string> = []
		for (const [key, picks] of input.map) {
			const need = needs.get(key) ?? null
			if (!need) {
				const declared = [...needs.keys()]
				const message = `credentials.${key} is not a need ${
					input.packageIds.length > 0
						? 'any package in this run declares'
						: 'of this code'
				}${declared.length > 0 ? ` (declared: ${declared.join(', ')})` : ''}.`
				if (input.strict) {
					throw refusal('credential_need_unknown', message)
				}
				warnings.push(
					`${message} It applies only to credential("${key}") calls, which read "${key}" as a provider.`,
				)
			}
			const target = needTarget(key, need)
			for (const pick of picks) {
				pickExplicit({ key, pick, usable, target })
			}
		}
		return { warnings }
	})
}

async function readHandle(
	ctx: Pick<CredentialClientContext, 'env' | 'callerContext' | 'binding'>,
	token: unknown,
	kinds: ReadonlyArray<PackageCredentialKind>,
	operation: string,
) {
	const handle = await verifyCredentialClientHandle({
		env: ctx.env,
		token: typeof token === 'string' ? token : '',
		request: ctx.callerContext.request,
		binding: ctx.binding,
	})
	if (!kinds.includes(handle.kind)) {
		throw refusal(
			'invalid_request',
			`A ${handle.kind} credential has no ${operation}.`,
		)
	}
	return handle
}

function doorInput<T extends CredentialTarget>(
	ctx: Pick<CredentialClientContext, 'env' | 'callerContext'>,
	credential: T,
): ResolveCredentialInput<T> {
	const request = ctx.callerContext.request!
	return {
		env: ctx.env,
		orgId: request.org.id,
		actor: request,
		packageStamp: null,
		baseUrl: ctx.callerContext.baseUrl,
		credential,
	}
}

async function withClientErrors<T>(run: () => Promise<T>) {
	try {
		return await run()
	} catch (error) {
		throw toCredentialClientError(error) ?? error
	}
}

export async function signWithCredentialClient(
	ctx: CredentialClientContext,
	input: { handle?: unknown; host?: unknown; operation?: unknown },
) {
	return await withClientErrors(async () => {
		const handle = await readHandle(ctx, input.handle, ['signing'], 'sign()')
		const host = readText(input.host, 'sign() host')
		const operation = input.operation as SigningOperation | undefined
		if (
			!operation ||
			typeof operation !== 'object' ||
			(operation.type !== 'jwt' && operation.type !== 'hmac')
		) {
			throw refusal(
				'invalid_request',
				'sign() takes { type: "jwt", ... } or { type: "hmac", ... }.',
			)
		}
		return await resolveCredential(
			doorInput(ctx, {
				use: 'signing',
				credentialId: handle.id,
				requestHost: host,
				operation,
			}),
		)
	})
}

export async function callToolWithCredentialClient(
	ctx: CredentialClientContext,
	input: { handle?: unknown; tool?: unknown; args?: unknown },
): Promise<CallToolResult> {
	return await withClientErrors(async () => {
		const handle = await readHandle(ctx, input.handle, ['mcp'], 'callTool()')
		const toolName = readText(input.tool, 'callTool() tool name')
		const args =
			input.args && typeof input.args === 'object' && !Array.isArray(input.args)
				? (input.args as Record<string, unknown>)
				: {}
		const request = ctx.callerContext.request!
		const server = await findCredentialById({
			db: ctx.env.APP_DB,
			ownerId: request.org.id,
			id: handle.id,
			scope: 'org',
		})
		const connection = await resolveCredential(
			doorInput(ctx, {
				use: 'mcp-connection',
				serverId: handle.id,
				serverName: server?.name ?? handle.name,
				waitUntil: ctx.waitUntil,
			}),
		)
		return await connection.callTool({ toolName, args })
	})
}

export async function refreshCredentialClient(
	ctx: CredentialClientContext,
	input: { handle?: unknown },
) {
	return await withClientErrors(async () => {
		const handle = await readHandle(ctx, input.handle, ['oauth'], 'refresh')
		return await resolveCredential(
			doorInput(ctx, {
				use: 'client-oauth-refresh',
				credentialId: handle.id,
				userEmail: ctx.callerContext.user?.email,
				waitUntil: ctx.waitUntil,
			}),
		)
	})
}

/** Where a client fetch's credential goes: a header, a query param, or a whole URL. */
export type CredentialClientPlacement =
	| { kind: 'header'; name: string; value: string }
	| { kind: 'query'; param: string; value: string }
	| { kind: 'url'; url: URL }

export type AppliedCredentialClient = {
	placement: CredentialClientPlacement
	substitutedValues: ReadonlyArray<string>
	/** The inject shape with no value, for a 401 / 403 hint. */
	shape: string
}

function fromResolved(
	placed: ResolvedClientPlacement,
): AppliedCredentialClient {
	return {
		placement: placed.placement,
		substitutedValues: placed.substitutedValues,
		shape: placed.shape,
	}
}

/**
 * The gateway's half of a client fetch: verify the handle, then resolve where
 * the credential goes on this request through the door. A header or query
 * placement replaces one of that name the code set; a `url` credential
 * replaces the request's origin and base path with its own URL.
 */
export async function applyCredentialClient(input: {
	env: Env
	request: RequestContext | null
	baseUrl: string
	binding: string | null | undefined
	token: string
	requestUrl: URL
}): Promise<AppliedCredentialClient> {
	return await withClientErrors(async () => {
		const handle = await verifyCredentialClientHandle({
			env: input.env,
			token: input.token,
			request: input.request,
			binding: input.binding,
		})
		const ctx = {
			env: input.env,
			callerContext: {
				baseUrl: input.baseUrl,
				request: input.request,
			} as McpCallerContext,
		}
		const { requestUrl } = input
		switch (handle.kind) {
			case 'secret':
				return fromResolved(
					await resolveCredential(
						doorInput(ctx, {
							use: 'client-key',
							credentialId: handle.id,
							requestUrl,
						}),
					),
				)
			case 'oauth':
				return fromResolved(
					await resolveCredential(
						doorInput(ctx, {
							use: 'client-oauth',
							credentialId: handle.id,
							requestUrl,
						}),
					),
				)
			case 'url': {
				const resolved = await resolveCredential(
					doorInput(ctx, {
						use: 'url',
						credentialId: handle.id,
						path: `${requestUrl.pathname}${requestUrl.search}`,
					}),
				)
				return {
					placement: { kind: 'url', url: resolved.url },
					substitutedValues: resolved.substitutedValues,
					shape: 'url',
				}
			}
			case 'login': {
				const session = await resolveCredential(
					doorInput(ctx, {
						use: 'login',
						credentialId: handle.id,
						requestUrl,
					}),
				)
				const { placement } = session
				return {
					placement,
					substitutedValues: session.substitutedValues,
					shape:
						placement.kind === 'header'
							? `login session in header ${placement.name}`
							: `login session in query ${placement.param}`,
				}
			}
			case 'mcp':
			case 'signing':
				throw refusal(
					'invalid_request',
					`A ${handle.kind} credential has no fetch; use ${handle.kind === 'mcp' ? 'callTool()' : 'sign()'}.`,
				)
			default: {
				const exhaustive: never = handle.kind
				throw new Error(`Unhandled credential kind: ${String(exhaustive)}`)
			}
		}
	})
}
