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
import { isMcpCallerError } from '#mcp/caller-error.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	credentialTriggerKinds,
	maxCredentialProposalValues,
	type CredentialMappingChange,
	type PackageCredentialsWriteFailure,
} from '#universal/credential-contracts.ts'
import { type routes } from '#universal/routes.ts'

const changeSchema = z.strictObject({
	target: z.discriminatedUnion('type', [
		z.strictObject({
			type: z.literal('default'),
			layer: z.enum(['org', 'mine']),
		}),
		z.strictObject({
			type: z.literal('trigger'),
			trigger: z.strictObject({
				kind: z.enum(credentialTriggerKinds),
				name: z.string().trim().min(1),
			}),
		}),
	]),
	needKey: z.string().trim().min(1),
	credentials: z
		.array(credentialPickSchema)
		.max(maxCredentialProposalValues)
		.nullable(),
})

const bodySchema = z.strictObject({
	changes: z.array(changeSchema).min(1).max(maxCredentialProposalValues),
})

/**
 * `/profiles/:username/packages/:kodyId/credentials.json`: the package
 * Credentials, Default mappings, and Triggers tabs. GET returns the
 * `PackageCredentialsView`; POST `{ changes }` applies every change or none
 * and returns the updated view. Signed-in sessions only; anyone without
 * `package:execute` on the package gets a 404.
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
						error: `Invalid request body: ${parsed.error.issues[0]?.message ?? 'expected { changes }'}.`,
					},
					400,
				)
			}
			const changes: Array<CredentialMappingChange> = parsed.data.changes
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
				await writeMappingChanges(scope, resolved)
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
