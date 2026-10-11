import { loadWritableAccountSavedPackage } from '#app/account-package-write-access.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { deleteSavedPackageProjection } from '#worker/package-registry/service.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function handleAccountPackageDeleteAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
}): Promise<Response | null> {
	const action = readTrimmedStringOrEmpty(input.body, 'action')
	if (action !== 'delete') return null

	const packageId = readTrimmedStringOrEmpty(input.body, 'packageId')
	const confirmName = readTrimmedStringOrEmpty(input.body, 'confirmName')
	if (!packageId) {
		return jsonResponse({ ok: false, error: 'Package id is required.' }, 400)
	}

	const resolved = await loadWritableAccountSavedPackage({
		env: input.env,
		user: input.user,
		packageId,
		permission: 'package:delete',
	})
	if (!resolved.ok) return resolved.response
	const { savedPackage, ownerUserId, actorUserId } = resolved.package
	if (confirmName !== savedPackage.name) {
		return jsonResponse(
			{
				ok: false,
				error: `Type the package name "${savedPackage.name}" to delete it.`,
			},
			400,
		)
	}

	try {
		await deleteSavedPackageProjection({
			env: input.env,
			userId: ownerUserId,
			actorUserId,
			packageId,
		})
	} catch (error) {
		if (error instanceof CommunityActionError) {
			return jsonResponse({ ok: false, error: error.message }, 400)
		}
		throw error
	}

	return jsonResponse({
		ok: true,
		deleted: true,
		packageId,
	})
}
