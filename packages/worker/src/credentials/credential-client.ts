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
import { type PackageCredentialKind } from '#worker/package-registry/types.ts'
import { enablementIdOf } from '#worker/request-context/request-context.ts'
import { buildCredentialCreateUrl } from '#universal/credential-contracts.ts'
import { buildNeedCreateUrl } from './need-create-url.ts'
import {
	CredentialClientHandleError,
	signCredentialClientHandle,
	verifyCredentialClientHandle,
} from './credential-client-handle.ts'
import {
	findCredentialById,
	listUsableCredentials,
	needCandidates,
	type UsableCredential,
} from './credential-candidates.ts'
import {
	type CredentialMappingRowTarget,
	loadCredentialMappings,
	resolveStoredMapping,
} from './credential-mappings.ts'
import { loadPublishedCredentialNeeds } from './credential-needs-closure.ts'
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
	/** Absolute creation link; always set for unbound, ambiguous, and not-found errors. */
	createUrl?: string
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
	// The link rides in the message too: a fetch rejection carries only that.
	const text = extra.createUrl
		? `${message} Create one at ${extra.createUrl}`
		: message
	return new CredentialClientError({
		code,
		message: text,
		retryWith: [],
		...extra,
	})
}

/**
 * The structured error for a failure from the door, else null. With a
 * `baseUrl`, a not-found error from the door carries a creation link.
 */
export function toCredentialClientError(
	error: unknown,
	options: { baseUrl?: string } = {},
) {
	if (error instanceof CredentialClientError) return error
	if (error instanceof CredentialRequestRefusedError) {
		return refusal(error.code, error.message)
	}
	if (error instanceof CredentialNotFoundError) {
		return refusal(
			'credential_not_found',
			error.message,
			options.baseUrl
				? { createUrl: buildCredentialCreateUrl(options.baseUrl, {}) }
				: {},
		)
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
	waitUntil?: (promise: Promise<unknown>) => void
}

export type OpenedCredentialClient = {
	handle: string
	key: string | null
	name: string
	scope: UsableCredential['scope']
	kind: PackageCredentialKind
	hosts: Array<string>
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

function readScope(value: unknown) {
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

function retryFor(key: string | null, credential: UsableCredential) {
	const pick = { name: credential.name, scope: credential.scope }
	return {
		...(key ? { credentials: { [key]: pick } } : {}),
		named: pick,
	}
}

async function loadNeed(ctx: CredentialClientContext, key: string) {
	if (!ctx.packageId) return { need: null, packageKodyId: null }
	const request = requireActorRequest(ctx)
	const saved = await getSavedPackageById(ctx.env.APP_DB, {
		userId: request.org.id,
		packageId: ctx.packageId,
	})
	if (!saved) return { need: null, packageKodyId: null }
	const needs = await loadPublishedCredentialNeeds({
		env: ctx.env,
		userId: saved.userId,
		sourceId: saved.sourceId,
	})
	return {
		need: needs.find((need) => need.key === key) ?? null,
		packageKodyId: saved.kodyId,
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

/**
 * No page creates these kinds yet, so the creation link lands on the
 * Secrets list; the agent can create one with secretSet instead.
 */
function secretSetHint(kind: PackageCredentialKind | null, provider: string) {
	switch (kind) {
		case 'url':
		case 'login':
		case 'signing':
			return `To create it, call secretSet with kind "${kind}" and provider "${provider}".`
		case 'secret':
		case 'oauth':
		case 'mcp':
		case null:
			return null
		default: {
			const exhaustive: never = kind
			throw new Error(`Unhandled credential kind: ${String(exhaustive)}`)
		}
	}
}

async function pickOne(input: {
	key: string | null
	candidates: Array<UsableCredential>
	possibleMatches: Array<UsableCredential>
	describe: string
	hint?: string | null
	createUrl: () => Promise<string>
}) {
	const [only, second] = input.candidates
	if (only && !second) return only
	if (!only) {
		throw refusal(
			'credential_unbound',
			`No credential you can use matches ${input.describe}.${
				input.possibleMatches.length > 0
					? ' Some of the same kind have no provider; pick one by name, or set its provider with credentialUpdate so it resolves on its own.'
					: ''
			}${input.hint ? ` ${input.hint}` : ''}`,
			{
				retryWith: input.possibleMatches.map((match) =>
					retryFor(input.key, match),
				),
				possibleMatches: input.possibleMatches.map(toOption),
				createUrl: await input.createUrl(),
			},
		)
	}
	throw refusal(
		'credential_ambiguous',
		`More than one credential you can use matches ${input.describe}. Pick one by name and scope.`,
		{
			retryWith: input.candidates.map((candidate) =>
				retryFor(input.key, candidate),
			),
			options: input.candidates.map(toOption),
			createUrl: await input.createUrl(),
		},
	)
}

/**
 * A package need's stored mapping (trigger override, then the actor's own
 * default, then the org default), or null to auto-resolve. Interactive runs
 * have no trigger override; a trigger run acts as its enabler.
 */
async function resolveMappedNeed(
	ctx: CredentialClientContext,
	input: {
		request: RequestContext
		key: string
		kind: PackageCredentialKind | null
		usable: Array<UsableCredential>
		createUrl: () => Promise<string>
	},
): Promise<UsableCredential | null> {
	if (!ctx.packageId) return null
	const enablementId = enablementIdOf(input.request)
	const rows = await loadCredentialMappings({
		db: ctx.env.APP_DB,
		orgId: input.request.org.id,
		packageId: ctx.packageId,
		personId: input.request.actor!.userId,
		enablementIds: enablementId ? [enablementId] : [],
		needKey: input.key,
	})
	const layer = (target: CredentialMappingRowTarget['target']) =>
		rows.find((row) => row.target.target === target)?.credentialIds ?? null
	const resolved = resolveStoredMapping({
		trigger: layer('enablement'),
		mine: layer('mine'),
		org: layer('org'),
		usable: input.usable,
		kind: input.kind,
	})
	if (!resolved) return null
	const where =
		resolved.source === 'trigger'
			? 'this trigger'
			: resolved.source === 'mine'
				? 'your default'
				: 'the org default'
	switch (resolved.status) {
		case 'ready':
			return resolved.credentials[0]!
		case 'none':
			throw refusal(
				'credential_unbound',
				`Need "${input.key}" is mapped to no credential on purpose (${where}). Change that mapping in the package's credential settings, or create a credential and map it.`,
				{ createUrl: await input.createUrl() },
			)
		case 'unusable':
			throw refusal(
				'credential_not_found',
				`The credential mapped to need "${input.key}" for ${where} is gone or you can no longer use it. Map another credential to it in the package's trigger settings.`,
				{ createUrl: await input.createUrl() },
			)
		default: {
			const exhaustive: never = resolved
			throw new Error(`Unhandled mapping status: ${JSON.stringify(exhaustive)}`)
		}
	}
}

export async function openCredentialClient(
	ctx: CredentialClientContext,
	input: { key?: unknown; name?: unknown; scope?: unknown },
): Promise<OpenedCredentialClient> {
	const request = requireActorRequest(ctx)
	const named = input.name != null
	const key = named ? null : readText(input.key, 'A credential key')
	const usable = await listUsableCredentials({ env: ctx.env, request })
	let picked: UsableCredential
	if (named) {
		await assertNamedAllowed(ctx)
		const name = readText(input.name, 'A credential name')
		const scope = readScope(input.scope)
		const matches = usable.filter(
			(credential) =>
				credential.name === name && (!scope || credential.scope === scope),
		)
		const createUrl = async () =>
			buildCredentialCreateUrl(ctx.callerContext.baseUrl, {
				name,
				orgSlug: request.org.slug,
			})
		if (matches.length === 0) {
			throw refusal(
				'credential_not_found',
				`No credential named "${name}" that you can use${scope ? ` in ${scope} scope` : ''}.`,
				{ createUrl: await createUrl() },
			)
		}
		picked = await pickOne({
			key: null,
			candidates: matches,
			possibleMatches: [],
			describe: `the name "${name}"`,
			createUrl,
		})
	} else {
		const { need, packageKodyId } = await loadNeed(ctx, key!)
		const kind = need?.kind ?? null
		const provider = need?.provider ?? key!
		const createUrl = () =>
			buildNeedCreateUrl({
				db: ctx.env.APP_DB,
				baseUrl: ctx.callerContext.baseUrl,
				key: key!,
				provider,
				need,
				packageKodyId,
				orgSlug: request.org.slug,
			})
		const mapped = await resolveMappedNeed(ctx, {
			request,
			key: key!,
			kind,
			usable,
			createUrl,
		})
		picked =
			mapped ??
			(await pickOne({
				key,
				candidates: needCandidates(usable, { kind, provider }),
				possibleMatches: kind
					? usable.filter(
							(credential) =>
								credential.kind === kind && credential.provider === null,
						)
					: [],
				describe: kind
					? `need "${key}" (${kind} from provider "${provider}")`
					: `provider "${provider}"`,
				hint: secretSetHint(kind, provider),
				createUrl,
			}))
	}
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
	}
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

async function withClientErrors<T>(
	baseUrl: string | undefined,
	run: () => Promise<T>,
) {
	try {
		return await run()
	} catch (error) {
		throw toCredentialClientError(error, { baseUrl }) ?? error
	}
}

export async function signWithCredentialClient(
	ctx: CredentialClientContext,
	input: { handle?: unknown; host?: unknown; operation?: unknown },
) {
	return await withClientErrors(ctx.callerContext.baseUrl, async () => {
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
	return await withClientErrors(ctx.callerContext.baseUrl, async () => {
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
	return await withClientErrors(ctx.callerContext.baseUrl, async () => {
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
	return await withClientErrors(input.baseUrl, async () => {
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
