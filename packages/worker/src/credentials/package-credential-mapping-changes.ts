/**
 * The one validator and writer for credential mapping edits: the package
 * Credentials tabs (POST credentials.json) and the approval page's Approve
 * both resolve changes here and write them in one batch, so a mapping is
 * never saved that the other path would refuse.
 */
import {
	planTriggerEnablementForCaller,
	TriggerEnablementError,
	type DeclaredTrigger,
} from '#worker/enablements/service.ts'
import {
	commitOrgAuditOutbox,
	orgAuditOutboxInsertStatement,
	orgAuditWriterFromRequest,
	planOrgAuditOutbox,
	type OrgAuditOutboxPlan,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'
import {
	type CredentialApprovalChangeView,
	type CredentialApprovalErrorCode,
	type CredentialMappingChange,
	type CredentialPick,
	type CredentialRef,
	describeCredentialMappingTarget,
} from '#universal/credential-contracts.ts'
import { type UsableCredential } from './credential-candidates.ts'
import {
	buildCredentialMappingUnchangedStatement,
	buildWriteCredentialMappingStatement,
	type CredentialMappingRowTarget,
} from './credential-mappings.ts'
import { type CredentialNeed } from './credential-needs.ts'
import {
	findStoredRow,
	needAcceptsKind,
	needAcceptsProvider,
	needCreateUrls,
	refsForIds,
	toCredentialRef,
	viewerEnablement,
	type PackageMappingScope,
} from './package-credential-mappings.ts'

/** One org audit row per mapping create, update, or clear. Never holds values. */
export const credentialMappingUpdateAuditAction = 'credential.mapping.update'

/** At most this many refs in one mapping for a `multiple` need. */
export const maxMappedCredentials = 16

export type ResolvedMappingChange = CredentialApprovalChangeView & {
	/** Ordered ids to store; null clears the override. */
	credentialIds: Array<string> | null
	/** The stored ids this replaces, usable or not; null when none are stored. */
	beforeCredentialIds: Array<string> | null
	/** Where the row lives; null when the trigger has no enablement yet. */
	rowTarget: CredentialMappingRowTarget | null
	trigger: DeclaredTrigger | null
}

type ChangeError = NonNullable<CredentialApprovalChangeView['error']>

class ChangeRefused extends Error {
	readonly error: ChangeError

	constructor(error: ChangeError) {
		super(error.message)
		this.error = error
	}
}

function refuse(
	code: CredentialApprovalErrorCode,
	message: string,
	createUrl?: string,
): never {
	throw new ChangeRefused({
		code,
		message,
		...(createUrl ? { createUrl } : {}),
	})
}

function describePick(pick: CredentialPick) {
	if ('id' in pick) return `id "${pick.id}"`
	return pick.scope
		? `${pick.scope} credential "${pick.name}"`
		: `"${pick.name}"`
}

function resolvePick(input: {
	pick: CredentialPick
	need: CredentialNeed
	usable: ReadonlyArray<UsableCredential>
	createUrl: string
}): UsableCredential {
	const { pick, need } = input
	const named =
		'id' in pick
			? input.usable.filter((credential) => credential.id === pick.id)
			: input.usable.filter(
					(credential) =>
						credential.name === pick.name &&
						(!pick.scope || credential.scope === pick.scope),
				)
	if (named.length === 0) {
		refuse(
			'credential_not_found',
			`No credential ${describePick(pick)} that you can use here.`,
			input.createUrl,
		)
	}
	const fitting = named.filter(
		(credential) =>
			needAcceptsKind(need.kind, credential.kind) &&
			needAcceptsProvider(need.provider, credential.provider),
	)
	const [only, second] = fitting.length > 0 ? fitting : named
	if (second) {
		refuse(
			'credential_ambiguous',
			`More than one credential matches ${describePick(pick)}. Pick it by scope or id.`,
		)
	}
	if (!needAcceptsKind(need.kind, only!.kind)) {
		refuse(
			'kind_mismatch',
			`"${only!.name}" is ${only!.kind}; need "${need.key}" takes ${need.kind ?? 'a Key, OAuth, or login credential'}.`,
		)
	}
	if (!needAcceptsProvider(need.provider, only!.provider)) {
		refuse(
			'provider_mismatch',
			`"${only!.name}" is for provider "${only!.provider}"; need "${need.key}" is for "${need.provider}".`,
		)
	}
	return only!
}

type TargetResolution = {
	rowTarget: CredentialMappingRowTarget | null
	trigger: DeclaredTrigger | null
	willEnable: boolean
}

function resolveTarget(
	scope: PackageMappingScope,
	change: CredentialMappingChange,
): TargetResolution {
	const { target } = change
	switch (target.type) {
		case 'default':
			if (target.layer === 'org') {
				if (!scope.canManage) {
					refuse('not_allowed', 'Only package managers set the org default.')
				}
				return {
					rowTarget: { target: 'org' },
					trigger: null,
					willEnable: false,
				}
			}
			return {
				rowTarget: { target: 'mine', personId: scope.actorId },
				trigger: null,
				willEnable: false,
			}
		case 'trigger': {
			const trigger = scope.triggers.find(
				(candidate) =>
					candidate.kind === target.trigger.kind &&
					candidate.name === target.trigger.name,
			)
			if (!trigger) {
				refuse(
					'trigger_unknown',
					`This package declares no ${describeCredentialMappingTarget(target)}.`,
				)
			}
			if (trigger.kind === 'webhook' && trigger.instanceId === null) {
				refuse(
					'webhook_not_minted',
					`Webhook "${trigger.name}" has no URL yet. Mint it first; minting turns it on for you.`,
				)
			}
			const { enablement, otherEnabler } = viewerEnablement(
				trigger,
				scope.actorId,
			)
			if (otherEnabler) {
				refuse(
					'webhook_other_enabler',
					`Webhook "${trigger.name}" runs as another person; only they map its credentials.`,
				)
			}
			return enablement
				? {
						rowTarget: {
							target: 'enablement',
							enablementId: enablement.id,
							personId: scope.actorId,
						},
						trigger,
						willEnable: false,
					}
				: {
						rowTarget: null,
						trigger,
						willEnable: change.credentials !== null,
					}
		}
		default: {
			const exhaustive: never = target
			throw new Error(`Unhandled mapping target: ${JSON.stringify(exhaustive)}`)
		}
	}
}

/**
 * Resolves each change for the scope's viewer: the need, the stored override
 * it replaces, the credentials it would store, and whether it turns a trigger
 * on. A change that cannot apply carries an `error` instead.
 */
export async function resolveMappingChanges(
	scope: PackageMappingScope,
	changes: ReadonlyArray<CredentialMappingChange>,
): Promise<Array<ResolvedMappingChange>> {
	const createUrls = await needCreateUrls(scope)
	return changes.map((change): ResolvedMappingChange => {
		const need = scope.needs.find(
			(candidate) => candidate.key === change.needKey,
		)
		const base = {
			target: change.target,
			needKey: change.needKey,
			need: need
				? {
						kind: need.kind ?? null,
						provider: need.provider,
						description: need.description,
						multiple: need.multiple,
					}
				: null,
		}
		let before: Array<CredentialRef> | null = null
		let beforeUnusableIds: Array<string> = []
		let beforeCredentialIds: Array<string> | null = null
		try {
			if (!need) {
				refuse(
					'need_unknown',
					`Package "${scope.savedPackage.kodyId}" has no credential need "${change.needKey}".`,
				)
			}
			const target = resolveTarget(scope, change)
			const stored = target.rowTarget
				? findStoredRow(scope, need.key, target.rowTarget)
				: null
			before = stored ? refsForIds(scope, stored.credentialIds) : null
			beforeCredentialIds = stored ? [...stored.credentialIds] : null
			const beforeUsableIds = new Set(before?.map((ref) => ref.id))
			beforeUnusableIds = (beforeCredentialIds ?? []).filter(
				(id) => !beforeUsableIds.has(id),
			)
			if (change.credentials === null) {
				return {
					...base,
					before,
					beforeUnusableIds,
					after: [],
					willEnable: false,
					error: null,
					credentialIds: null,
					beforeCredentialIds,
					rowTarget: target.rowTarget,
					trigger: target.trigger,
				}
			}
			const limit = need.multiple ? maxMappedCredentials : 1
			if (change.credentials.length > limit) {
				refuse(
					'too_many',
					need.multiple
						? `Need "${need.key}" takes at most ${limit} credentials.`
						: `Need "${need.key}" takes one credential.`,
				)
			}
			const usable =
				change.target.type === 'default' && change.target.layer === 'org'
					? scope.usable.filter((credential) => credential.scope === 'org')
					: scope.usable
			const picked = change.credentials.map((pick) =>
				resolvePick({
					pick,
					need,
					usable,
					createUrl: createUrls.get(need.key)!,
				}),
			)
			const unique = [...new Map(picked.map((c) => [c.id, c])).values()]
			return {
				...base,
				before,
				beforeUnusableIds,
				after: unique.map(toCredentialRef),
				willEnable: target.willEnable,
				error: null,
				credentialIds: unique.map((credential) => credential.id),
				beforeCredentialIds,
				rowTarget: target.rowTarget,
				trigger: target.trigger,
			}
		} catch (error) {
			if (!(error instanceof ChangeRefused)) throw error
			return {
				...base,
				before,
				beforeUnusableIds,
				after: [],
				willEnable: false,
				error: error.error,
				credentialIds: null,
				beforeCredentialIds,
				rowTarget: null,
				trigger: null,
			}
		}
	})
}

function mappingAuditPlan(
	audit: OrgAuditWriter,
	scope: PackageMappingScope,
	change: ResolvedMappingChange,
): OrgAuditOutboxPlan {
	const trigger =
		change.target.type === 'trigger' ? change.target.trigger : null
	return planOrgAuditOutbox(audit, {
		orgId: scope.savedPackage.userId,
		action: credentialMappingUpdateAuditAction,
		resourceType: 'package',
		resourceId: scope.savedPackage.id,
		details: {
			packageId: scope.savedPackage.id,
			kodyId: scope.savedPackage.kodyId,
			needKey: change.needKey,
			target: change.target,
			trigger,
			beforeCredentialIds: change.beforeCredentialIds,
			afterCredentialIds: change.credentialIds,
			willEnable: change.willEnable,
		},
	})
}

/**
 * A trigger that could not be turned on at write time (it changed since the
 * changes were resolved). `webhook_other_enabler` is a conflict; the other
 * codes mean the change no longer applies.
 */
export class MappingWriteRefused extends Error {
	readonly change: ResolvedMappingChange
	readonly code: TriggerEnablementError['code']

	constructor(change: ResolvedMappingChange, cause: TriggerEnablementError) {
		super(cause.message)
		this.name = 'MappingWriteRefused'
		this.change = change
		this.code = cause.code
	}
}

/** A mapping the write would replace changed after the changes were resolved. */
export class MappingChangedSinceResolve extends Error {
	constructor() {
		super('A mapping changed after these changes were resolved.')
		this.name = 'MappingChangedSinceResolve'
	}
}

function isMalformedJsonError(error: unknown) {
	return error instanceof Error && /malformed JSON/i.test(error.message)
}

function changeTargetKey(change: ResolvedMappingChange) {
	const { target } = change
	const where =
		target.type === 'default'
			? `default:${target.layer}`
			: `trigger:${target.trigger.kind}:${target.trigger.name}`
	return `${where}\u0000${change.needKey}`
}

/**
 * Writes resolved changes in one batch, turning on any trigger a change maps
 * for the first time, and records one `credential.mapping.update` org audit
 * row per written mapping (actor and automation credential from the request;
 * package, trigger, need, and old/new credential ids in details — never
 * values). Every change must have resolved without an error. When one
 * request edits the same need and target twice, the last edit wins, so a set
 * then clear never turns a trigger on. With `requireUnchanged` (Approve),
 * each replaced row must still hold what was resolved, or nothing is written
 * and it throws `MappingChangedSinceResolve`.
 */
export async function writeMappingChanges(
	scope: PackageMappingScope,
	resolved: ReadonlyArray<ResolvedMappingChange>,
	options: { now?: string; requireUnchanged?: boolean } = {},
) {
	const now = options.now ?? new Date().toISOString()
	if (resolved.some((change) => change.error)) {
		throw new Error('Refusing to write mapping changes that have errors.')
	}
	const finalChanges = [
		...new Map(
			resolved.map((change) => [changeTargetKey(change), change]),
		).values(),
	]
	const db = scope.env.APP_DB
	const audit = orgAuditWriterFromRequest(scope.env, scope.request)
	const enableStatements: Array<D1PreparedStatement> = []
	const prepares: Array<() => Promise<void>> = []
	const enabledIds = new Map<DeclaredTrigger, string>()
	const guards: Array<D1PreparedStatement> = []
	const statements: Array<D1PreparedStatement> = []
	const auditPlans: Array<OrgAuditOutboxPlan> = []
	for (const change of finalChanges) {
		let rowTarget = change.rowTarget
		if (!rowTarget && change.willEnable && change.trigger) {
			let enablementId = enabledIds.get(change.trigger)
			if (!enablementId) {
				const plan = await planTriggerEnablementForCaller({
					env: scope.env,
					baseUrl: scope.baseUrl,
					request: scope.request,
					savedPackage: scope.savedPackage,
					kind: change.trigger.kind,
					name: change.trigger.name,
					now,
				}).catch((error: unknown) => {
					if (error instanceof TriggerEnablementError) {
						throw new MappingWriteRefused(change, error)
					}
					throw error
				})
				if (plan.enablement) {
					enablementId = plan.enablement.id
				} else {
					enablementId = plan.enablementId
					enableStatements.push(plan.statement)
					prepares.push(plan.prepare)
				}
				enabledIds.set(change.trigger, enablementId)
			}
			rowTarget = {
				target: 'enablement',
				enablementId,
				personId: scope.actorId,
			}
		}
		if (!rowTarget) continue
		// A trigger that was off at resolve may have been turned on and mapped
		// since; its adopted enablement must still have no row.
		if (options.requireUnchanged) {
			guards.push(
				buildCredentialMappingUnchangedStatement({
					db,
					orgId: scope.savedPackage.userId,
					packageId: scope.savedPackage.id,
					needKey: change.needKey,
					target: rowTarget,
					credentialIds: change.beforeCredentialIds,
				}),
			)
		}
		statements.push(
			buildWriteCredentialMappingStatement({
				db,
				orgId: scope.savedPackage.userId,
				packageId: scope.savedPackage.id,
				needKey: change.needKey,
				target: rowTarget,
				credentialIds: change.credentialIds,
				updatedByUserId: scope.actorId,
				now,
			}),
		)
		auditPlans.push(mappingAuditPlan(audit, scope, change))
	}
	const batch = [
		...guards,
		...enableStatements,
		...statements,
		...auditPlans.map((plan) => orgAuditOutboxInsertStatement(db, plan)),
	]
	if (batch.length > 0) {
		try {
			await db.batch(batch)
		} catch (error) {
			if (guards.length > 0 && isMalformedJsonError(error)) {
				throw new MappingChangedSinceResolve()
			}
			throw error
		}
	}
	// After the batch: a rejected write must not leave a new signing secret.
	for (const prepare of prepares) await prepare()
	for (const plan of auditPlans) {
		await commitOrgAuditOutbox({ ...audit, appDb: db }, plan)
	}
}
