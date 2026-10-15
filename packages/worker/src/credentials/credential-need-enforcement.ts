/**
 * Credential-need enforcement (issue #3822, ADR 0068 amendment 2026-10-15).
 *
 * A package run by anyone but its author may use only the credentials its
 * `kody.credentials` closure declares: fetch gateway placeholders and
 * `credential(key)` alike. "Its author" means the package lives in the acting
 * person's personal org, is not an unadopted community fork, and is not
 * internet-visible. Ad hoc code (no package stamp) is never limited.
 * Placement stays fill-anywhere; this is about declaration only.
 */
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import { credentialNeedEnforcementFlagKey } from '#universal/feature-flags/registry.ts'
import { isFeatureGloballyEnabled } from '#worker/feature-flags/service.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { loadPublishedEntityManifest } from '#worker/repo/published-source.ts'
import { loadPublishedCredentialNeeds } from './credential-needs-closure.ts'
import { type CredentialNeed } from './credential-needs.ts'

export const credentialNeedUndeclaredCode = 'credential_need_undeclared'

/** One credential use to check, in the words of the code that made it. */
export type CredentialNeedReference =
	| { use: 'secret'; name: string; scope: SecretScope | null }
	| { use: 'integration'; name: string }
	| { use: 'provider'; provider: string }
	| { use: 'key'; key: string }

export class CredentialNeedUndeclaredError extends McpCallerError {
	readonly code = credentialNeedUndeclaredCode
	/** The kody.credentials key to declare. */
	readonly key: string
	/** The message without its leading code. */
	readonly detail: string
	constructor(input: { key: string; message: string }) {
		// The code leads the message so a fetch rejection, which carries only
		// the message, still says which error it is.
		super(`[${credentialNeedUndeclaredCode}] ${input.message}`)
		this.name = 'CredentialNeedUndeclaredError'
		this.key = input.key
		this.detail = input.message
	}
}

type Declarations = {
	needs: ReadonlyArray<CredentialNeed>
	mountNames: ReadonlySet<string>
}

type EnforcedPackage =
	| { kind: 'exempt' }
	| {
			kind: 'enforced'
			saved: SavedPackageRecord | null
			stored: () => Promise<Declarations>
			fresh: () => Promise<Declarations>
	  }

const enforcementByRequest = new WeakMap<
	RequestContext,
	Map<string, Promise<EnforcedPackage>>
>()
const flagByRequest = new WeakMap<RequestContext, Promise<boolean>>()

function memo<T>(load: () => Promise<T>) {
	let promise: Promise<T> | null = null
	return () => (promise ??= load())
}

/** Package and session buckets are bound to the package by construction. */
function isPackageBoundScope(scope: SecretScope | null) {
	return scope === 'package' || scope === 'session'
}

function referenceKey(reference: CredentialNeedReference) {
	switch (reference.use) {
		case 'secret':
		case 'integration':
			return reference.name
		case 'provider':
			return reference.provider
		case 'key':
			return reference.key
		default: {
			const exhaustive: never = reference
			throw new Error(`Unhandled reference: ${String(exhaustive)}`)
		}
	}
}

/** Declared slot kinds that may fill a use; an omitted kind fills any. */
function fillingKind(reference: CredentialNeedReference) {
	switch (reference.use) {
		case 'secret':
		case 'provider':
			return 'secret'
		case 'integration':
			return 'oauth'
		case 'key':
			return null
		default: {
			const exhaustive: never = reference
			throw new Error(`Unhandled reference: ${String(exhaustive)}`)
		}
	}
}

export function isCredentialReferenceDeclared(
	reference: CredentialNeedReference,
	declarations: Declarations,
) {
	if (reference.use === 'secret') {
		if (isPackageBoundScope(reference.scope)) return true
		if (declarations.mountNames.has(reference.name)) return true
	}
	const key = referenceKey(reference)
	const kind = fillingKind(reference)
	return declarations.needs.some(
		(need) =>
			need.key === key &&
			(kind === null || need.kind == null || need.kind === kind),
	)
}

function describeUse(reference: CredentialNeedReference) {
	switch (reference.use) {
		case 'secret':
			return `the secret "${reference.name}"`
		case 'integration':
			return `the integration "${reference.name}"`
		case 'provider':
			return `the vault provider "${reference.provider}"`
		case 'key':
			return `the credential key "${reference.key}"`
		default: {
			const exhaustive: never = reference
			throw new Error(`Unhandled reference: ${String(exhaustive)}`)
		}
	}
}

function undeclaredError(
	reference: CredentialNeedReference,
	saved: SavedPackageRecord | null,
) {
	const key = referenceKey(reference)
	const subject = saved ? `Package ${saved.name}` : 'This package'
	return new CredentialNeedUndeclaredError({
		key,
		message: `${subject} uses ${describeUse(reference)} without declaring it. A package run by anyone but its author may use only the credentials it declares. Add "${key}" to kody.credentials in its package.json (with a description) and publish again.`,
	})
}

async function isAuthorsOwnPackage(input: {
	env: Env
	request: RequestContext | null
	saved: SavedPackageRecord
}) {
	const person = input.request?.actor
	if (!person || input.saved.isInternetVisible) return false
	const personalOrgId = await loadPersonalOrgIdForPerson(
		input.env.APP_DB,
		person.userId,
	)
	if (input.saved.userId !== personalOrgId) return false
	const unadoptedFork = await input.env.APP_DB.prepare(
		`SELECT 1 AS fork FROM community_forks
		WHERE forked_package_id = ? AND adopted_at IS NULL
		LIMIT 1`,
	)
		.bind(input.saved.id)
		.first<{ fork: number }>()
	return !unadoptedFork
}

async function loadMountNames(env: Env, saved: SavedPackageRecord) {
	const names = new Set<string>()
	const manifest = await loadPublishedEntityManifest({
		env,
		userId: saved.userId,
		sourceId: saved.sourceId,
	}).then(
		(published) => published.manifest,
		// An unpublished package declares nothing.
		() => null,
	)
	if (!manifest) return names
	for (const [alias, mount] of Object.entries(
		manifest.kody.secretMounts ?? {},
	)) {
		names.add(alias)
		names.add(mount.name)
	}
	return names
}

async function loadEnforcedPackage(input: {
	env: Env
	request: RequestContext | null
	orgId: string
	packageId: string
}): Promise<EnforcedPackage> {
	const saved = await getSavedPackageById(input.env.APP_DB, {
		userId: input.orgId,
		packageId: input.packageId,
	})
	const empty = async (): Promise<Declarations> => ({
		needs: [],
		mountNames: new Set(),
	})
	if (!saved)
		return { kind: 'enforced', saved: null, stored: empty, fresh: empty }
	if (await isAuthorsOwnPackage({ ...input, saved })) return { kind: 'exempt' }
	const mountNames = memo(() => loadMountNames(input.env, saved))
	const declarations = (fresh: boolean) =>
		memo(async () => ({
			needs: await loadPublishedCredentialNeeds({
				env: input.env,
				userId: saved.userId,
				sourceId: saved.sourceId,
				fresh,
			}),
			mountNames: await mountNames(),
		}))
	return {
		kind: 'enforced',
		saved,
		stored: declarations(false),
		fresh: declarations(true),
	}
}

function enforcedPackageFor(input: {
	env: Env
	request: RequestContext | null
	orgId: string
	packageId: string
}) {
	if (!input.request) return loadEnforcedPackage(input)
	let byPackage = enforcementByRequest.get(input.request)
	if (!byPackage) {
		byPackage = new Map()
		enforcementByRequest.set(input.request, byPackage)
	}
	const cacheKey = `${input.orgId}\n${input.packageId}`
	let loaded = byPackage.get(cacheKey)
	if (!loaded) {
		loaded = loadEnforcedPackage(input)
		byPackage.set(cacheKey, loaded)
		loaded.catch(() => byPackage.delete(cacheKey))
	}
	return loaded
}

function isEnforcementOn(env: Env, request: RequestContext | null) {
	const load = () =>
		isFeatureGloballyEnabled(env.APP_DB, credentialNeedEnforcementFlagKey)
	if (!request) return load()
	let enabled = flagByRequest.get(request)
	if (!enabled) {
		enabled = load()
		flagByRequest.set(request, enabled)
		enabled.catch(() => flagByRequest.delete(request))
	}
	return enabled
}

/**
 * Throws {@link CredentialNeedUndeclaredError} for the first use the stamped
 * package does not declare. A use the stored closure misses is checked again
 * against a closure recomputed from the package's imports, so a dependency
 * that declared a need after this package published still counts.
 */
export async function assertCredentialUsesDeclared(input: {
	env: Env
	request: RequestContext | null
	orgId: string
	packageId: string | null
	references: ReadonlyArray<CredentialNeedReference>
}) {
	if (!input.packageId || input.references.length === 0) return
	if (!(await isEnforcementOn(input.env, input.request))) return
	const enforced = await enforcedPackageFor({
		env: input.env,
		request: input.request,
		orgId: input.orgId,
		packageId: input.packageId,
	})
	if (enforced.kind === 'exempt') return
	const stored = await enforced.stored()
	const missing = input.references.filter(
		(reference) => !isCredentialReferenceDeclared(reference, stored),
	)
	if (missing.length === 0) return
	const fresh = await enforced.fresh()
	const undeclared = missing.find(
		(reference) => !isCredentialReferenceDeclared(reference, fresh),
	)
	if (undeclared) throw undeclaredError(undeclared, enforced.saved)
}
