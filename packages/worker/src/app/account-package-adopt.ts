import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { loadAccountPackagesData } from '#app/account-packages-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { adoptCommunityFork } from '#worker/community/service.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { authorizePackageWrite } from '#worker/authorization/authorize.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

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
	const userId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId,
		packageId,
	})
	if (!savedPackage) {
		return jsonResponse({ ok: false, error: 'Package not found.' }, 404)
	}
	try {
		await authorizePackageWrite(
			{ env: input.env, request: input.user.request },
			{
				id: savedPackage.id,
				userId: savedPackage.userId,
				label: savedPackage.name,
			},
		)
		await adoptCommunityFork({
			env: input.env,
			userId,
			packageId,
			reviewSummary: readTrimmedStringOrEmpty(input.body, 'reviewNote'),
		})
	} catch (error) {
		if (error instanceof CommunityActionError) {
			return jsonResponse({ ok: false, error: error.message }, 400)
		}
		if (error instanceof McpCallerError) {
			return jsonResponse({ ok: false, error: error.message }, 403)
		}
		throw error
	}
	return jsonResponse(
		await loadAccountPackagesData({
			env: input.env,
			request: input.request,
			user: input.user,
			pathPackageId: packageId,
		}),
	)
}
