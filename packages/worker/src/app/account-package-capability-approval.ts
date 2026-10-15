import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	type AuthenticatedAppUser,
	type readAuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { loadWritableAccountSavedPackage } from '#app/account-package-write-access.ts'
import { reloadAccountPackagesAfterWrite } from '#app/account-packages-data.ts'
import {
	approveCredentialNeedsRequest,
	approveWentPublicRequest,
	loadPendingPackageApprovals,
} from '#app/account-package-approval-requests.ts'
import { routes } from '#universal/routes.ts'
import {
	approvePackageCapabilitySet,
	CapabilityApprovalError,
	clearInternetVisible,
	loadCapabilityApprovalSummary,
} from '#worker/package-capabilities/capability-approval-service.ts'
import { buildPackageCapabilityApprovalUrl } from '#worker/package-capabilities/capability-approval-url.ts'
import {
	enqueueWentPublicApproval,
	getPendingWentPublicApproval,
} from '#worker/package-capabilities/went-public-approval.ts'
import { loadPackageSecurityAuditState } from '#worker/package-capabilities/security-audit-state.ts'
import { loadPackageSecurityAuditNextStep } from '#worker/package-capabilities/security-audit-next-step.ts'
import { type AccountPackageApproveCapabilitiesLoaderData } from '#universal/loader-data.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import { viewerCanManageSavedPackage } from '#app/package-viewer-access.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function loadAccountPackageApproveCapabilitiesData(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	packageId: string
}): Promise<
	AccountPackageApproveCapabilitiesLoaderData | { ok: false; error: string }
> {
	const savedPackage = await getSavedPackageByIdInAnyOrg(
		input.env.APP_DB,
		input.packageId,
	)
	if (
		!savedPackage ||
		!(await viewerCanManageSavedPackage({
			env: input.env,
			viewer: input.user.mcpUser,
			ownerId: savedPackage.userId,
			packageId: savedPackage.id,
		}))
	) {
		return { ok: false, error: 'Package not found.' }
	}

	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.user.mcpUser.userId,
		savedPackage.userId,
	)
	const username = binding?.org.slug ?? input.user.username
	const summary = await loadCapabilityApprovalSummary({
		env: input.env,
		ownerUserId: savedPackage.userId,
		savedPackage,
		requestUrl: input.request.url,
	})

	const packageHref = routes.communityPackage.href({
		username,
		kodyId: savedPackage.kodyId,
	})
	const settingsHref = routes.communityPackageSettings.href({
		username,
		kodyId: savedPackage.kodyId,
	})
	const approveHref = routes.communityPackageApproveCapabilities.href({
		username,
		kodyId: savedPackage.kodyId,
	})

	const [pendingApprovals, securityAudit] = await Promise.all([
		loadPendingPackageApprovals({
			env: input.env,
			ownerUserId: savedPackage.userId,
			packageId: savedPackage.id,
			publishedCommit: summary.publishedCommit,
		}),
		loadPackageSecurityAuditState({
			db: input.env.APP_DB,
			ownerUserId: savedPackage.userId,
			packageId: savedPackage.id,
			packageName: savedPackage.name,
			publishedCommit: summary.publishedCommit,
			fingerprint: summary.capabilitySet.fingerprint,
			approvalUrl: buildPackageCapabilityApprovalUrl({
				baseUrl: new URL(input.request.url).origin,
				username,
				kodyId: savedPackage.kodyId,
			}),
		}),
	])

	// A pending went_public request means the owner asked to go public; when
	// the capability set still needs approval, one Approve records both.
	const goPublicRequestId =
		!savedPackage.isInternetVisible && !summary.fingerprintMatchesApproval
			? (pendingApprovals.find((approval) => approval.reason === 'went_public')
					?.id ?? null)
			: null

	return {
		ok: true,
		pendingApprovals,
		goPublicRequestId,
		email: input.user.email,
		package: {
			id: savedPackage.id,
			name: savedPackage.name,
			kodyId: savedPackage.kodyId,
			sourceId: savedPackage.sourceId,
			hasApp: savedPackage.hasApp,
			isInternetVisible: savedPackage.isInternetVisible,
		},
		publishedCommit: summary.publishedCommit,
		fingerprint: summary.capabilitySet.fingerprint,
		entries: summary.capabilitySet.entries,
		fingerprintMatchesApproval: summary.fingerprintMatchesApproval,
		// Timestamp for the matching fingerprint row, not the chronologically
		// latest approval (which may be a different capability set).
		latestApprovedAt: summary.matchingApproval?.approvedAt ?? null,
		securityAudit,
		settingsHref,
		packageHref,
		approveHref,
	}
}

type PackageDecisionAuditAction =
	| 'package.capabilities.approve'
	| 'package.went_public.approve'

async function auditPackageDecision(input: {
	env: Env
	user: AuthenticatedUser
	ownerUserId: string
	actorUserId: string
	savedPackage: { id: string; kodyId: string }
	action: PackageDecisionAuditAction
	result: 'success' | 'failure'
	details: Record<string, unknown>
}) {
	await logOrgAuditEvent({
		env: input.env,
		orgId: input.ownerUserId,
		action: input.action,
		result: input.result,
		actorUserId: input.actorUserId,
		actorUsername: input.user.username,
		credentialKind: 'session',
		resourceType: 'package',
		resourceId: input.savedPackage.id,
		details: {
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			...input.details,
		},
	}).catch((error: unknown) => {
		console.error('Failed to audit package approval decision:', {
			packageId: input.savedPackage.id,
			action: input.action,
			error: getErrorMessage(error),
		})
	})
}

function readBodyString(body: object, key: string) {
	const value: unknown = (body as Record<string, unknown>)[key]
	return typeof value === 'string' ? value.trim() : ''
}

export async function handleAccountPackageInternetVisibleAction(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}): Promise<Response | null> {
	const action = readBodyString(input.body, 'action')
	if (
		action !== 'set-internet-visible' &&
		action !== 'approve-capabilities' &&
		action !== 'approve-capabilities-and-go-public' &&
		action !== 'approve-credential-needs' &&
		action !== 'approve-went-public'
	) {
		return null
	}

	const packageId = readBodyString(input.body, 'packageId')
	if (!packageId) {
		return jsonResponse({ ok: false, error: 'Package id is required.' }, 400)
	}

	const resolved = await loadWritableAccountSavedPackage({
		env: input.env,
		user: input.user,
		packageId,
		permission: 'package:publish',
	})
	if (!resolved.ok) return resolved.response
	const { savedPackage, ownerUserId, actorUserId } = resolved.package

	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.user.mcpUser.userId,
		ownerUserId,
	)
	const username = binding?.org.slug ?? input.user.username
	const approvalUrl = buildPackageCapabilityApprovalUrl({
		baseUrl: new URL(input.request.url).origin,
		username,
		kodyId: savedPackage.kodyId,
	})

	const audit = (
		auditAction: PackageDecisionAuditAction,
		result: 'success' | 'failure',
		details: Record<string, unknown>,
	) =>
		auditPackageDecision({
			env: input.env,
			user: input.user,
			ownerUserId,
			actorUserId,
			savedPackage,
			action: auditAction,
			result,
			details,
		})

	const approveCapabilities = async (
		expectedFingerprint: string,
		options: { enqueueWentPublic?: boolean } = {},
	) => {
		try {
			const approved = await approvePackageCapabilitySet({
				env: input.env,
				ownerUserId,
				actorUserId,
				savedPackage,
				requestUrl: input.request.url,
				expectedFingerprint,
				...options,
			})
			await audit('package.capabilities.approve', 'success', {
				fingerprint: approved.capabilitySet.fingerprint,
				publishedCommit: approved.approval.publishedCommit,
				approvalId: approved.approval.id,
			})
			return { ok: true as const, approved }
		} catch (error) {
			if (error instanceof CapabilityApprovalError) {
				await audit('package.capabilities.approve', 'failure', {
					fingerprint: expectedFingerprint,
					error: error.message,
				})
				return {
					ok: false as const,
					response: jsonResponse(
						{ ok: false, error: error.message, approvalUrl },
						400,
					),
				}
			}
			throw error
		}
	}

	const approveWentPublic = async (requestId: string) => {
		const approved = await approveWentPublicRequest({
			env: input.env,
			request: input.request,
			savedPackage,
			ownerUserId,
			actorUserId,
			requestId,
		})
		await audit(
			'package.went_public.approve',
			approved.ok ? 'success' : 'failure',
			approved.ok ? { requestId } : { requestId, error: approved.error },
		)
		return approved
	}

	const reloaded = async () =>
		jsonResponse(
			await reloadAccountPackagesAfterWrite({
				env: input.env,
				request: input.request,
				user: input.user,
				packageId,
				ownerUserId,
			}),
		)

	if (
		action === 'approve-credential-needs' ||
		action === 'approve-went-public' ||
		action === 'approve-capabilities-and-go-public'
	) {
		const requestId = readBodyString(input.body, 'requestId')
		if (!requestId) {
			return jsonResponse(
				{ ok: false, error: 'Approval request id is required.' },
				400,
			)
		}
		if (action === 'approve-capabilities-and-go-public') {
			// A request turned off in another tab gets no pin either.
			const pending = await getPendingWentPublicApproval({
				env: input.env,
				ownerUserId,
				packageId: savedPackage.id,
			})
			if (pending?.id !== requestId) {
				return jsonResponse(
					{
						ok: false,
						error:
							'The request to make this package internet-visible changed. Reload the page.',
						approvalUrl,
					},
					409,
				)
			}
			// One click, two decisions: the capability pin, then this exact
			// went_public request. Each keeps its own checks and audit event.
			// The pin does not enqueue, so a request turned off meanwhile stays
			// off and approving it below fails.
			const capabilities = await approveCapabilities(
				readBodyString(input.body, 'fingerprint'),
				{ enqueueWentPublic: false },
			)
			if (!capabilities.ok) return capabilities.response
		}
		const approved =
			action === 'approve-credential-needs'
				? await approveCredentialNeedsRequest({
						env: input.env,
						request: input.request,
						savedPackage,
						ownerUserId,
						actorUserId,
						requestId,
					})
				: await approveWentPublic(requestId)
		if (!approved.ok) {
			return jsonResponse(
				{ ok: false, error: approved.error, approvalUrl },
				approved.status,
			)
		}
		return await reloaded()
	}

	if (action === 'approve-capabilities') {
		const capabilities = await approveCapabilities(
			readBodyString(input.body, 'fingerprint'),
		)
		if (!capabilities.ok) return capabilities.response
		return await reloaded()
	}

	const internetVisible =
		'internetVisible' in input.body && input.body.internetVisible === true
	const confirmName = readBodyString(input.body, 'confirmName')

	if (!internetVisible) {
		if (confirmName !== savedPackage.kodyId) {
			return jsonResponse(
				{
					ok: false,
					error: `Type the package slug "${savedPackage.kodyId}" to turn off internet-visible serving.`,
				},
				400,
			)
		}
		const changed = await clearInternetVisible({
			env: input.env,
			ownerUserId,
			packageId,
			actorUserId,
		})
		if (!changed) {
			return jsonResponse({ ok: false, error: 'Package not found.' }, 404)
		}
		return await reloaded()
	}

	if (confirmName !== savedPackage.kodyId) {
		return jsonResponse(
			{
				ok: false,
				error: `Type the package slug "${savedPackage.kodyId}" to continue. Review and approve the capability summary first.`,
				approvalUrl,
			},
			400,
		)
	}
	try {
		const summary = await loadCapabilityApprovalSummary({
			env: input.env,
			ownerUserId,
			savedPackage,
			requestUrl: input.request.url,
		})
		if (!summary.publishedCommit) {
			return jsonResponse(
				{
					ok: false,
					error: 'Publish the package before making it internet-visible.',
				},
				400,
			)
		}
		if (summary.fingerprintMatchesApproval) {
			// Refresh the pin for the current published commit (same
			// fingerprint can still need a new snapshot row) and enqueue
			// went_public.
			await approvePackageCapabilitySet({
				env: input.env,
				ownerUserId,
				actorUserId,
				savedPackage,
				requestUrl: input.request.url,
				expectedFingerprint: summary.capabilitySet.fingerprint,
			})
		} else {
			// Record the ask so the approval page offers one Approve for the
			// capability set and going public together.
			await enqueueWentPublicApproval({
				env: input.env,
				ownerUserId,
				savedPackage,
				publishedCommit: summary.publishedCommit,
				fingerprint: summary.capabilitySet.fingerprint,
				requestedByUserId: actorUserId,
			})
		}
		const securityAudit = await loadPackageSecurityAuditNextStep({
			db: input.env.APP_DB,
			ownerUserId,
			packageId: savedPackage.id,
			packageName: savedPackage.name,
			publishedCommit: summary.publishedCommit,
			fingerprint: summary.capabilitySet.fingerprint,
			approvalUrl,
		})
		const approvalStep = summary.fingerprintMatchesApproval
			? 'Approve making this package internet-visible on the approval page.'
			: 'Review the credentials and capabilities on the approval page. One Approve records them and makes this package internet-visible.'
		return jsonResponse(
			{
				ok: false,
				error: securityAudit
					? `${approvalStep} No security audit is recorded for this version yet; the approval page has a prompt to copy for your agent.`
					: approvalStep,
				approvalUrl,
				...(securityAudit ? { securityAudit } : {}),
			},
			400,
		)
	} catch (error) {
		if (error instanceof CapabilityApprovalError) {
			return jsonResponse({ ok: false, error: error.message, approvalUrl }, 400)
		}
		throw error
	}
}
