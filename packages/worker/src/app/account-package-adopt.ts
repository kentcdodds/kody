import { loadAccountPackagesData } from '#app/account-packages-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { adoptCommunityFork } from '#worker/community/service.ts'
import { jsonResponse } from '#worker/json-response.ts'

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
	try {
		await adoptCommunityFork({
			env: input.env,
			userId: input.user.mcpUser.userId,
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
		await loadAccountPackagesData({
			env: input.env,
			request: input.request,
			user: input.user,
			pathPackageId: packageId,
		}),
	)
}
