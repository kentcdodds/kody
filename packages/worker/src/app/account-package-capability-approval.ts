import { jsonResponse } from '#worker/json-response.ts'
import {
	type AuthenticatedAppUser,
	type readAuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { loadWritableAccountSavedPackage } from '#app/account-package-write-access.ts'
import { reloadAccountPackagesAfterWrite } from '#app/account-packages-data.ts'
import { routes } from '#universal/routes.ts'
import {
	approvePackageCapabilitySet,
	CapabilityApprovalError,
	clearInternetVisible,
	loadCapabilityApprovalSummary,
} from '#worker/package-capabilities/capability-approval-service.ts'
import { buildPackageCapabilityApprovalUrl } from '#worker/package-capabilities/capability-approval-url.ts'
import { type AccountPackageApproveCapabilitiesLoaderData } from '#universal/loader-data.ts'
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

	return {
		ok: true,
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
		latestApprovedAt: summary.latestApproval?.approvedAt ?? null,
		settingsHref,
		packageHref,
		approveHref,
	}
}

export async function handleAccountPackageInternetVisibleAction(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}): Promise<Response | null> {
	const action =
		'action' in input.body && typeof input.body.action === 'string'
			? input.body.action.trim()
			: ''
	if (action !== 'set-internet-visible' && action !== 'approve-capabilities') {
		return null
	}

	const packageId =
		'packageId' in input.body && typeof input.body.packageId === 'string'
			? input.body.packageId.trim()
			: ''
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

	try {
		if (action === 'approve-capabilities') {
			const expectedFingerprint =
				'fingerprint' in input.body &&
				typeof input.body.fingerprint === 'string'
					? input.body.fingerprint.trim()
					: ''
			await approvePackageCapabilitySet({
				env: input.env,
				ownerUserId,
				actorUserId,
				savedPackage,
				requestUrl: input.request.url,
				expectedFingerprint,
			})
		} else {
			const internetVisible =
				'internetVisible' in input.body && input.body.internetVisible === true
			const confirmName =
				'confirmName' in input.body &&
				typeof input.body.confirmName === 'string'
					? input.body.confirmName.trim()
					: ''

			if (internetVisible) {
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
				if (!summary.fingerprintMatchesApproval) {
					return jsonResponse(
						{
							ok: false,
							error:
								'Review and approve the credential and capability summary before making this package internet-visible.',
							approvalUrl,
						},
						400,
					)
				}
				await approvePackageCapabilitySet({
					env: input.env,
					ownerUserId,
					actorUserId,
					savedPackage,
					requestUrl: input.request.url,
					expectedFingerprint: summary.capabilitySet.fingerprint,
				})
			} else {
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
				})
				if (!changed) {
					return jsonResponse({ ok: false, error: 'Package not found.' }, 404)
				}
			}
		}
	} catch (error) {
		if (error instanceof CapabilityApprovalError) {
			return jsonResponse({ ok: false, error: error.message, approvalUrl }, 400)
		}
		throw error
	}

	return jsonResponse(
		await reloadAccountPackagesAfterWrite({
			env: input.env,
			request: input.request,
			user: input.user,
			packageId,
			ownerUserId,
		}),
	)
}
