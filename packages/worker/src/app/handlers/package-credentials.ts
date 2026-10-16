import { type Action } from 'remix/router'
import { z } from 'zod'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadPackageMappingScopeForViewer } from '#app/package-credentials-access.ts'
import { credentialPickSchema } from '#worker/credentials/credential-pick-schema.ts'
import {
	MappingWriteRefused,
	resolveMappingChanges,
	writeMappingChanges,
} from '#worker/credentials/package-credential-mapping-changes.ts'
import {
	buildPackageCredentialsView,
	loadPackageMappingScope,
} from '#worker/credentials/package-credential-mappings.ts'
import { getEnablementById } from '#worker/enablements/repo.ts'
import {
	disableEnablementForCaller,
	enableTriggerForCaller,
	planTriggerEnablementForCaller,
	runNewEnablementPlans,
	TriggerEnablementError,
} from '#worker/enablements/service.ts'
import { isMcpCallerError } from '#mcp/caller-error.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	credentialTriggerKinds,
	maxCredentialProposalValues,
	type CredentialMappingChange,
	type PackageCredentialsEnablementAction,
	type PackageCredentialsWriteFailure,
} from '#universal/credential-contracts.ts'
import { type routes } from '#universal/routes.ts'

const triggerRefSchema = z.strictObject({
	kind: z.enum(credentialTriggerKinds),
	name: z.string().trim().min(1),
})

const changeSchema = z.strictObject({
	target: z.discriminatedUnion('type', [
		z.strictObject({
			type: z.literal('default'),
			layer: z.enum(['org', 'mine']),
		}),
		z.strictObject({
			type: z.literal('trigger'),
			trigger: triggerRefSchema,
			enablementId: z.string().trim().min(1).optional(),
			createInstance: z.boolean().optional(),
		}),
	]),
	needKey: z.string().trim().min(1),
	credentials: z
		.array(credentialPickSchema)
		.max(maxCredentialProposalValues)
		.nullable(),
})

const enablementActionSchema = z.strictObject({
	trigger: triggerRefSchema,
	state: z.enum(['on', 'off']),
	enablementId: z.string().trim().min(1).optional(),
	createInstance: z.boolean().optional(),
})

const bodySchema = z
	.strictObject({
		changes: z.array(changeSchema).max(maxCredentialProposalValues).optional(),
		enablements: z.array(enablementActionSchema).max(16).optional(),
	})
	.refine(
		(body) =>
			(body.changes?.length ?? 0) > 0 || (body.enablements?.length ?? 0) > 0,
		{ message: 'expected { changes } and/or { enablements }' },
	)

async function requirePackageTriggerEnablement(input: {
	env: Env
	scope: NonNullable<
		Awaited<ReturnType<typeof loadPackageMappingScopeForViewer>>
	>
	enablementId: string
	trigger: PackageCredentialsEnablementAction['trigger']
}) {
	const actorId = input.scope.request.actor?.userId
	if (!actorId) {
		throw new TriggerEnablementError(
			'trigger_unknown',
			'Only a signed-in person can change trigger enablements.',
		)
	}
	const enablement = await getEnablementById({
		db: input.env.APP_DB,
		orgId: input.scope.savedPackage.userId,
		id: input.enablementId,
	})
	const notFound = new TriggerEnablementError(
		'trigger_unknown',
		`Enablement "${input.enablementId}" was not found for this package trigger.`,
	)
	if (!enablement) throw notFound
	if (enablement.packageId !== input.scope.savedPackage.id) throw notFound
	if (enablement.triggerKind !== input.trigger.kind) throw notFound
	if (enablement.triggerName !== input.trigger.name) throw notFound
	if (String(enablement.enablerUserId) !== String(actorId)) throw notFound
	return enablement
}

/** Reject malformed enablement actions before any mapping write runs. */
async function validateEnablementActions(input: {
	env: Env
	scope: NonNullable<
		Awaited<ReturnType<typeof loadPackageMappingScopeForViewer>>
	>
	actions: ReadonlyArray<PackageCredentialsEnablementAction>
}) {
	for (const action of input.actions) {
		if (action.state === 'off') {
			if (!action.enablementId) {
				throw new TriggerEnablementError(
					'trigger_unknown',
					'Turning a trigger off needs its enablement id.',
				)
			}
			await requirePackageTriggerEnablement({
				env: input.env,
				scope: input.scope,
				enablementId: action.enablementId,
				trigger: action.trigger,
			})
			continue
		}
		if (action.enablementId && !action.createInstance) {
			const named = await requirePackageTriggerEnablement({
				env: input.env,
				scope: input.scope,
				enablementId: action.enablementId,
				trigger: action.trigger,
			})
			if (named.state === 'off') {
				throw new TriggerEnablementError(
					'trigger_unknown',
					`Enablement "${action.enablementId}" is off. Turn the trigger on without an enablement id to create another instance.`,
				)
			}
		}
	}
}

async function applyEnablementActions(input: {
	env: Env
	scope: NonNullable<
		Awaited<ReturnType<typeof loadPackageMappingScopeForViewer>>
	>
	actions: ReadonlyArray<PackageCredentialsEnablementAction>
}) {
	await validateEnablementActions(input)
	for (const action of input.actions) {
		if (action.state === 'off') {
			await disableEnablementForCaller({
				env: input.env,
				request: input.scope.request,
				enablementId: action.enablementId!,
			})
			continue
		}
		if (action.createInstance) {
			const plan = await planTriggerEnablementForCaller({
				env: input.env,
				baseUrl: input.scope.baseUrl,
				request: input.scope.request,
				savedPackage: input.scope.savedPackage,
				kind: action.trigger.kind,
				name: action.trigger.name,
				createInstance: true,
			})
			if (plan.enablement) continue
			await runNewEnablementPlans({
				db: input.env.APP_DB,
				plans: [plan],
			})
			continue
		}
		if (action.enablementId) {
			// Validated above: named live enablement already exists for the viewer.
			continue
		}
		await enableTriggerForCaller({
			env: input.env,
			baseUrl: input.scope.baseUrl,
			request: input.scope.request,
			packageIdOrKodyId: input.scope.savedPackage.id,
			kind: action.trigger.kind,
			name: action.trigger.name,
		})
	}
}

/**
 * `/profiles/:username/packages/:kodyId/credentials.json`: the package
 * Credentials, Default mappings, and Triggers tabs. GET returns the
 * `PackageCredentialsView`; POST `{ changes }` and/or `{ enablements }`
 * applies every change or none and returns the updated view. Signed-in
 * sessions only; anyone without `package:execute` on the package gets a 404.
 */
export function createPackageCredentialsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			if (request.method !== 'GET' && request.method !== 'POST') {
				return jsonResponse(
					{ ok: false, error: 'Method not allowed.' },
					{ status: 405, headers: { Allow: 'GET, POST' } },
				)
			}
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const scope = await loadPackageMappingScopeForViewer({
				env,
				request,
				user,
				username: params.username,
				kodyId: params.kodyId,
			})
			if (!scope) {
				return jsonResponse({ ok: false, error: 'Package not found.' }, 404)
			}
			if (request.method === 'GET') {
				return jsonResponse(await buildPackageCredentialsView(scope))
			}
			const parsed = bodySchema.safeParse(
				await request.json().catch(() => null),
			)
			if (!parsed.success) {
				return jsonResponse(
					{
						ok: false,
						error: `Invalid request body: ${parsed.error.issues[0]?.message ?? 'expected { changes } and/or { enablements }'}.`,
					},
					400,
				)
			}
			const changes: Array<CredentialMappingChange> = parsed.data.changes ?? []
			const enablements = parsed.data.enablements ?? []
			if (changes.length > 0) {
				const resolved = await resolveMappingChanges(scope, changes)
				const errors = resolved.flatMap((change) =>
					change.error
						? [
								{
									needKey: change.needKey,
									target: change.target,
									...change.error,
								},
							]
						: [],
				)
				if (errors.length > 0) {
					return jsonResponse(
						{ ok: false, errors } satisfies PackageCredentialsWriteFailure,
						400,
					)
				}
				try {
					// Validate enablements before any mapping write so a bad off
					// action cannot leave a willEnable mapping half-applied.
					if (enablements.length > 0) {
						await validateEnablementActions({
							env,
							scope,
							actions: enablements,
						})
					}
					// Mapping writes before enablement mutations so a failed
					// mapping does not leave enablements half-applied.
					await writeMappingChanges(scope, resolved)
					if (enablements.length > 0) {
						await applyEnablementActions({ env, scope, actions: enablements })
					}
				} catch (error) {
					if (
						error instanceof MappingWriteRefused &&
						error.code !== 'webhook_other_enabler' &&
						error.code !== 'email_sender_conflict' &&
						error.change
					) {
						return jsonResponse(
							{
								ok: false,
								errors: [
									{
										needKey: error.change.needKey,
										target: error.change.target,
										code: error.code,
										message: error.message,
									},
								],
							} satisfies PackageCredentialsWriteFailure,
							400,
						)
					}
					if (error instanceof TriggerEnablementError) {
						const conflict =
							error.code === 'webhook_other_enabler' ||
							error.code === 'email_sender_conflict'
						return jsonResponse(
							{ ok: false, error: error.message },
							{ status: conflict ? 409 : 400 },
						)
					}
					// A webhook or email sender someone else turned on between resolve and write.
					if (
						!(error instanceof MappingWriteRefused) &&
						!(isMcpCallerError(error) && error instanceof Error)
					) {
						throw error
					}
					return jsonResponse(
						{ ok: false, error: error.message },
						{ status: 409 },
					)
				}
			} else {
				try {
					await applyEnablementActions({ env, scope, actions: enablements })
				} catch (error) {
					if (error instanceof TriggerEnablementError) {
						const conflict =
							error.code === 'webhook_other_enabler' ||
							error.code === 'email_sender_conflict'
						return jsonResponse(
							{ ok: false, error: error.message },
							{ status: conflict ? 409 : 400 },
						)
					}
					if (isMcpCallerError(error) && error instanceof Error) {
						return jsonResponse(
							{ ok: false, error: error.message },
							{ status: 409 },
						)
					}
					throw error
				}
			}
			const fresh = await loadPackageMappingScope({
				env,
				baseUrl: scope.baseUrl,
				request: scope.request,
				savedPackage: scope.savedPackage,
				canManage: scope.canManage,
			})
			return jsonResponse(await buildPackageCredentialsView(fresh))
		},
	} satisfies Action<
		| typeof routes.communityPackageCredentialsApi
		| typeof routes.communityPackageCredentialsApiPost
	>
}
