import { type Action } from 'remix/router'
import { z } from 'zod'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadPackageMappingScopeForViewer } from '#app/package-credentials-access.ts'
import {
	approveCredentialProposal,
	resolveCredentialApproval,
} from '#worker/credentials/credential-approval.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	parseCredentialApprovalQuery,
	type CredentialApprovalFailure,
	type CredentialApprovalSuccess,
} from '#universal/credential-contracts.ts'
import { type routes } from '#universal/routes.ts'

const bodySchema = z.strictObject({
	action: z.literal('approve'),
	fingerprint: z.string().trim().min(1),
})

/**
 * `/profiles/:username/packages/:kodyId/approve-credentials.json?<proposal>`:
 * the credential approval page. GET returns the `CredentialApprovalView` for
 * the signed-in viewer; POST `{ action: 'approve', fingerprint }` writes the
 * reviewed changes in one batch. Anyone without `package:execute` gets a 404.
 */
export function createPackageCredentialApprovalApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params, url }) {
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
			const proposal = parseCredentialApprovalQuery(url.searchParams)
			if (request.method === 'GET') {
				return jsonResponse(
					(await resolveCredentialApproval(scope, proposal)).view,
				)
			}
			const parsed = bodySchema.safeParse(
				await request.json().catch(() => null),
			)
			if (!parsed.success) {
				return jsonResponse(
					{
						ok: false,
						error: `Invalid request body: ${parsed.error.issues[0]?.message ?? "expected { action: 'approve', fingerprint }"}.`,
					},
					400,
				)
			}
			const outcome = await approveCredentialProposal({
				scope,
				proposal,
				fingerprint: parsed.data.fingerprint,
			})
			switch (outcome.status) {
				case 'approved':
					return jsonResponse({
						ok: true,
						view: outcome.view,
					} satisfies CredentialApprovalSuccess)
				case 'invalid':
					return jsonResponse(
						{
							ok: false,
							error:
								'This proposal has errors to fix before it can be approved.',
							view: outcome.view,
						} satisfies CredentialApprovalFailure,
						400,
					)
				case 'stale':
					return jsonResponse(
						{
							ok: false,
							error:
								'Credentials or mappings changed since you reviewed this proposal. Review the updated changes and approve again.',
							view: outcome.view,
						} satisfies CredentialApprovalFailure,
						409,
					)
				case 'conflict':
					return jsonResponse(
						{
							ok: false,
							error: outcome.message,
							view: outcome.view,
						} satisfies CredentialApprovalFailure,
						409,
					)
				default: {
					const exhaustive: never = outcome
					throw new Error(`Unhandled approval outcome: ${String(exhaustive)}`)
				}
			}
		},
	} satisfies Action<
		| typeof routes.communityPackageApproveCredentialsApi
		| typeof routes.communityPackageApproveCredentialsApiPost
	>
}
