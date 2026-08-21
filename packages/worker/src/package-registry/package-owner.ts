import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { getUsernameFormatValidationError } from '#worker/identity/username.ts'
import {
	getPlatformAccountByUsername,
	hasPackageScopeGrant,
} from './scope-grants.ts'
import { getMcpUserPackageScope } from './user-scope.ts'

/**
 * Caller-clearable package scope denial (invalid scope, non-platform target,
 * or missing grant). Lives in the worker layer so MCP capabilities and shared
 * resolvers can throw it without importing `#mcp/*`; observability treats it
 * like `CommunityActionError` and keeps it off Sentry (KODY-CLOUDFLARE-5N).
 */
export class PackageScopeAccessError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PackageScopeAccessError'
	}
}

/**
 * The acting-user / owning-account pair for a package operation.
 *
 * `ownerUserId` (a stable MCP user id) is the only id that may be used for
 * storage: `saved_packages.user_id`, `entity_sources.user_id`, Vectorize
 * metadata, repo-session RPC ownership, entitlements, and community listing
 * ownership. `actorUserId` is the signed-in caller and is used for audit and
 * attribution only. The two are equal for personal-scope operations and
 * differ only when acting under a package scope grant on a platform account.
 */
export type PackageOwnerContext = {
	ownerUserId: string
	ownerScope: string
	ownerEmail: string
	actorUserId: string
	delegated: boolean
}

export const packageScopeInputDescription =
	'Optional platform account scope (without "@") only when you already hold an explicit package scope grant for that account. Omit to act in your own personal scope. Do not guess a platform scope you have not been granted.'

function normalizeRequestedScope(scope: string | undefined) {
	const normalized = scope?.trim().toLowerCase().replace(/^@/, '') ?? ''
	return normalized || null
}

/**
 * Resolve the effective package owner for a capability call.
 *
 * Without `requestedScope` (or when it matches the caller's own username)
 * this preserves existing behavior: the caller is the owner. With a foreign
 * `requestedScope`, the scope must belong to a platform account
 * (`users.account_type = 'platform'`) and the caller must hold an explicit
 * grant row. Person accounts are never resolvable as a foreign scope, so
 * acting as another user is unrepresentable here by construction.
 *
 * Delegated resolutions are recorded in the audit log with the acting
 * caller's email so scope use stays attributable to a person.
 */
export async function resolvePackageOwnerContext(
	env: Pick<Env, 'APP_DB' | 'AUDIT_DB' | 'SENTRY_ENVIRONMENT'>,
	user: McpUserContext,
	requestedScope?: string,
): Promise<PackageOwnerContext> {
	const db = env.APP_DB
	const ownScope = await getMcpUserPackageScope(db, user)
	const scope = normalizeRequestedScope(requestedScope)
	if (!scope || scope === ownScope) {
		return {
			ownerUserId: user.userId,
			ownerScope: ownScope,
			ownerEmail: user.email,
			actorUserId: user.userId,
			delegated: false,
		}
	}

	const formatError = getUsernameFormatValidationError(scope)
	if (formatError) {
		throw new PackageScopeAccessError(
			`Invalid package scope "@${scope}": ${formatError}`,
		)
	}
	const platformAccount = await getPlatformAccountByUsername(db, scope)
	if (!platformAccount) {
		throw new PackageScopeAccessError(
			`Package scope "@${scope}" is not a platform account scope you can act in. Omit package_scope to use your personal scope.`,
		)
	}
	const granted = await hasPackageScopeGrant(db, {
		scopeOwnerUserId: platformAccount.stableUserId,
		granteeUserId: user.userId,
	})
	if (!granted) {
		throw new PackageScopeAccessError(
			`You do not have a package scope grant for "@${scope}". Omit package_scope to use your personal scope, or ask an admin to grant access to that platform account.`,
		)
	}
	await logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: 'package_scope_delegated_access',
		result: 'success',
		email: user.email,
		path: '/mcp',
		reason: `scope=@${platformAccount.username}`,
	})
	return {
		ownerUserId: platformAccount.stableUserId,
		ownerScope: platformAccount.username,
		ownerEmail: platformAccount.email,
		actorUserId: user.userId,
		delegated: true,
	}
}
