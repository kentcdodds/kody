import { reloadAccountPackagesAfterWrite } from '#app/account-packages-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { viewerIsSavedPackageOrgOwner } from '#app/package-viewer-access.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { adoptCommunityFork } from '#worker/community/service.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function handleAccountPackageAdoptAction(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}): Promise<Response | null> {
	const action = readTrimmedStringOrEmpty(input.body, 'action')
	if (action !== 'adopt-community-fork') return null

	const packageId = readTrimmedStringOrEmpty(input.body, 'packageId')
	if (!packageId) {
		return jsonResponse({ ok: false, error: 'Package id is required.' }, 400)
	}
	const savedPackage = await getSavedPackageByIdInAnyOrg(
		input.env.APP_DB,
		packageId,
	)
	if (
		!savedPackage ||
		!(await viewerIsSavedPackageOrgOwner({
			env: input.env,
			viewer: input.user.mcpUser,
			ownerId: savedPackage.userId,
		}))
	) {
		return jsonResponse({ ok: false, error: 'Package not found.' }, 404)
	}
	const ownerUserId = savedPackage.userId
	try {
		await adoptCommunityFork({
			env: input.env,
			userId: ownerUserId,
			packageId,
			reviewSummary: readTrimmedStringOrEmpty(input.body, 'reviewNote'),
		})
	} catch (error) {
		if (error instanceof CommunityActionError) {
			return jsonResponse({ ok: false, error: error.message }, 400)
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
