/**
 * The one validator and writer for credential mapping edits: the package
 * Credentials tabs (POST credentials.json) and the approval page's Approve
 * both resolve changes here and write them in one batch, so a mapping is
 * never saved that the other path would refuse.
 */
import {
	planTriggerEnablementForCaller,
	runNewEnablementPlans,
	type DeclaredTrigger,
	type NewTriggerEnablementPlan,
} from '#worker/enablements/service.ts'
import {
	type CredentialApprovalChangeView,
	type CredentialApprovalEnableView,
	type CredentialApprovalErrorCode,
	type CredentialMappingChange,
	type CredentialPick,
	type CredentialRef,
	type CredentialTriggerRef,
	describeCredentialMappingTarget,
} from '#universal/credential-contracts.ts'
import { type UsableCredential } from './credential-candidates.ts'
import {
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

/** At most this many refs in one mapping for a `multiple` need. */
export const maxMappedCredentials = 16

export type ResolvedMappingChange = CredentialApprovalChangeView & {
	/** Ordered ids to store; null clears the override. */
	credentialIds: Array<string> | null
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

/**
 * The declared trigger and the viewer's enablement of it. Refuses a trigger
 * the package does not declare, an unminted webhook, and a webhook someone
 * else already runs.
 */
function resolveViewerTrigger(
	scope: PackageMappingScope,
	ref: CredentialTriggerRef,
) {
	const trigger = scope.triggers.find(
		(candidate) => candidate.kind === ref.kind && candidate.name === ref.name,
	)
	if (!trigger) {
		refuse(
			'trigger_unknown',
			`This package declares no ${describeCredentialMappingTarget({ type: 'trigger', trigger: ref })}.`,
		)
	}
	if (trigger.kind === 'webhook' && trigger.instanceId === null) {
		refuse(
			'webhook_not_minted',
			`Webhook "${trigger.name}" has no URL yet. Mint its URL first, then approve it here.`,
		)
	}
	const { enablement, otherEnabler } = viewerEnablement(trigger, scope.actorId)
	if (otherEnabler) {
		refuse(
			'webhook_other_enabler',
			`Webhook "${trigger.name}" runs as another person; only they map its credentials.`,
		)
	}
	return { trigger, enablement }
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
			const { trigger, enablement } = resolveViewerTrigger(
				scope,
				target.trigger,
			)
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
						kind: need.kind,
						provider: need.provider,
						description: need.description,
						multiple: need.multiple,
					}
				: null,
		}
		let before: Array<CredentialRef> | null = null
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
			if (change.credentials === null) {
				return {
					...base,
					before,
					after: [],
					willEnable: false,
					error: null,
					credentialIds: null,
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
				after: unique.map(toCredentialRef),
				willEnable: target.willEnable,
				error: null,
				credentialIds: unique.map((credential) => credential.id),
				rowTarget: target.rowTarget,
				trigger: target.trigger,
			}
		} catch (error) {
			if (!(error instanceof ChangeRefused)) throw error
			return {
				...base,
				before,
				after: [],
				willEnable: false,
				error: error.error,
				credentialIds: null,
				rowTarget: null,
				trigger: null,
			}
		}
	})
}

export type ResolvedTriggerEnable = CredentialApprovalEnableView & {
	declared: DeclaredTrigger | null
}

/**
 * Resolves triggers a proposal turns on without mapping anything: a webhook
 * with no credential needs still goes through Approve.
 */
export function resolveTriggerEnables(
	scope: PackageMappingScope,
	refs: ReadonlyArray<CredentialTriggerRef>,
): Array<ResolvedTriggerEnable> {
	return refs.map((ref) => {
		const trigger = { kind: ref.kind, name: ref.name }
		try {
			const { trigger: declared, enablement } = resolveViewerTrigger(scope, ref)
			return {
				trigger,
				willEnable: enablement === null,
				error: null,
				declared,
			}
		} catch (error) {
			if (!(error instanceof ChangeRefused)) throw error
			return {
				trigger,
				willEnable: false,
				error: { code: error.error.code, message: error.error.message },
				declared: null,
			}
		}
	})
}

/**
 * Writes resolved changes in one batch, turning on any trigger a change maps
 * for the first time and every trigger in `enable` that is not on yet. A
 * webhook turned on lands in its own batch just before, so losing a race to
 * another enabler throws `webhook_other_enabler` with nothing else written.
 * Every change and enable must have resolved without an error.
 */
export async function writeMappingChanges(
	scope: PackageMappingScope,
	resolved: ReadonlyArray<ResolvedMappingChange>,
	options: {
		now?: string
		enable?: ReadonlyArray<ResolvedTriggerEnable>
	} = {},
) {
	const now = options.now ?? new Date().toISOString()
	const enable = options.enable ?? []
	if (
		resolved.some((change) => change.error) ||
		enable.some((entry) => entry.error)
	) {
		throw new Error('Refusing to write mapping changes that have errors.')
	}
	const db = scope.env.APP_DB
	const newEnablements: Array<NewTriggerEnablementPlan> = []
	const enabledIds = new Map<DeclaredTrigger, string>()
	const statements: Array<D1PreparedStatement> = []
	const enableTrigger = async (trigger: DeclaredTrigger) => {
		const known = enabledIds.get(trigger)
		if (known) return known
		const plan = await planTriggerEnablementForCaller({
			env: scope.env,
			baseUrl: scope.baseUrl,
			request: scope.request,
			savedPackage: scope.savedPackage,
			kind: trigger.kind,
			name: trigger.name,
			now,
		})
		let enablementId: string
		if (plan.enablement) {
			enablementId = plan.enablement.id
		} else {
			enablementId = plan.enablementId
			newEnablements.push(plan)
		}
		enabledIds.set(trigger, enablementId)
		return enablementId
	}
	for (const entry of enable) {
		if (entry.willEnable && entry.declared) await enableTrigger(entry.declared)
	}
	for (const change of resolved) {
		let rowTarget = change.rowTarget
		if (!rowTarget && change.willEnable && change.trigger) {
			const enablementId = await enableTrigger(change.trigger)
			rowTarget = {
				target: 'enablement',
				enablementId,
				personId: scope.actorId,
			}
		}
		if (!rowTarget) continue
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
	}
	for (const plan of newEnablements) await plan.prepare()
	// A webhook insert can lose to another enabler without failing. Land those
	// first and alone: mappings and other enablements are only written once
	// every webhook is known to be in, so none points at an enablement that
	// was never inserted.
	const webhookEnablements = newEnablements.filter(
		(plan) => plan.kind === 'webhook',
	)
	await runNewEnablementPlans({ db, plans: webhookEnablements })
	const batch = [
		...newEnablements
			.filter((plan) => plan.kind !== 'webhook')
			.map((plan) => plan.statement),
		...statements,
	]
	if (batch.length > 0) await db.batch(batch)
}
