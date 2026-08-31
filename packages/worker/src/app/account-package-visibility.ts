import { jsonResponse } from '#worker/json-response.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import {
	publishCommunityListing,
	unpublishCommunityListing,
} from '#worker/community/service.ts'
import { getCommunityListingByOwnerAndPackage } from '#worker/community/repo.ts'
import {
	getSavedPackageById,
	updateSavedPackage,
} from '#worker/package-registry/repo.ts'
import { loadAccountPackagesData } from '#app/account-packages-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function handleAccountPackageVisibilityAction(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}): Promise<Response | null> {
	const action = readTrimmedStringOrEmpty(input.body, 'action')
	if (action !== 'set-visibility') return null

	const packageId = readTrimmedStringOrEmpty(input.body, 'packageId')
	const visibility = readTrimmedStringOrEmpty(input.body, 'visibility')
	const confirmName = readTrimmedStringOrEmpty(input.body, 'confirmName')
	if (!packageId) {
		return jsonResponse({ ok: false, error: 'Package id is required.' }, 400)
	}
	if (visibility !== 'public' && visibility !== 'private') {
		return jsonResponse(
			{ ok: false, error: 'Visibility must be public or private.' },
			400,
		)
	}

	const userId = input.user.mcpUser.userId
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId,
		packageId,
	})
	if (!savedPackage) {
		return jsonResponse({ ok: false, error: 'Package not found.' }, 404)
	}

	try {
		if (visibility === 'public' && savedPackage.isPrivate) {
			await publishCommunityListing({
				env: input.env,
				baseUrl: new URL(input.request.url).origin,
				userId,
				actorUserId: userId,
				packageId,
			})
		} else if (visibility === 'private' && !savedPackage.isPrivate) {
			if (confirmName !== savedPackage.kodyId) {
				return jsonResponse(
					{
						ok: false,
						error: `Type the package slug "${savedPackage.kodyId}" to make it private. Public URLs will 404; existing forks keep their copies.`,
					},
					400,
				)
			}
			const listing = await getCommunityListingByOwnerAndPackage(
				input.env.APP_DB,
				{
					ownerUserId: userId,
					packageId,
				},
			)
			if (listing && listing.status === 'active') {
				await unpublishCommunityListing({
					env: input.env,
					userId,
					actorUserId: userId,
					listingId: listing.id,
				})
			} else {
				const changed = await updateSavedPackage(input.env.APP_DB, {
					userId,
					packageId,
					isPrivate: true,
				})
				if (!changed) {
					return jsonResponse({ ok: false, error: 'Package not found.' }, 404)
				}
			}
		}
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
