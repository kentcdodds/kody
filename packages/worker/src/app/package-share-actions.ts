import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type PackageShareGrantLoaderView } from '#universal/package-share.ts'
import {
	defaultPackageShareTrustLevel,
	requireHydratedPackageShareGrantView,
	packageShareAccessErrorMessage,
	PackageShareAccessError,
	acceptPackageShare,
	acknowledgePackageShareUpdate,
	invitePackageShare,
	leavePackageShare,
	revokePackageShare,
	toPackageShareGrantLoaderView,
	type PackageShareTrustLevel,
} from '#worker/package-registry/share-grants.ts'
import { assertSharePinAcknowledgeReview } from '#worker/package-registry/share-pin-review.ts'
import { sendPackageShareInviteEmail } from '#worker/package-registry/share-invite-email.ts'

const shareIntents = [
	'invite',
	'accept',
	'revoke',
	'leave',
	'acknowledge',
] as const

type ShareIntent = (typeof shareIntents)[number]

export type PackageShareMutationResult =
	| { ok: true; grant: PackageShareGrantLoaderView }
	| { ok: false; error: string; status: number }

function isShareIntent(value: string): value is ShareIntent {
	return (shareIntents as ReadonlyArray<string>).includes(value)
}

function isTrustLevel(value: string): value is PackageShareTrustLevel {
	return value === 'follow' || value === 'pin'
}

function readString(body: Record<string, unknown>, key: string) {
	const value = body[key]
	return typeof value === 'string' ? value.trim() : ''
}

export async function applyPackageShareMutation(input: {
	env: Env
	user: AuthenticatedAppUser
	body: unknown
	packageId?: string
	requestUrl: string
}): Promise<PackageShareMutationResult> {
	if (
		!input.body ||
		typeof input.body !== 'object' ||
		Array.isArray(input.body)
	) {
		return { ok: false, error: 'Invalid request body.', status: 400 }
	}
	const body = input.body as Record<string, unknown>
	const intent = readString(body, 'intent')
	if (!isShareIntent(intent)) {
		return { ok: false, error: 'Unknown share action.', status: 400 }
	}
	const grantId = readString(body, 'grantId')
	const packageId = input.packageId || readString(body, 'packageId')
	try {
		switch (intent) {
			case 'invite': {
				if (!packageId) {
					return {
						ok: false,
						error: 'Package id is required to invite.',
						status: 400,
					}
				}
				const grant = await invitePackageShare({
					db: input.env.APP_DB,
					owner: input.user.mcpUser,
					packageId,
					invitee: {
						username: readString(body, 'username') || undefined,
						email: readString(body, 'email') || undefined,
					},
				})
				await sendPackageShareInviteEmail({
					env: input.env,
					requestUrl: input.requestUrl,
					grant,
				})
				return {
					ok: true,
					grant: toPackageShareGrantLoaderView(
						await requireHydratedPackageShareGrantView({
							db: input.env.APP_DB,
							grant,
						}),
					),
				}
			}
			case 'accept': {
				const trustValue = readString(body, 'trustLevel')
				const grant = await acceptPackageShare({
					db: input.env.APP_DB,
					guest: input.user.mcpUser,
					grantId: grantId || undefined,
					packageId: packageId || undefined,
					trustLevel: isTrustLevel(trustValue)
						? trustValue
						: defaultPackageShareTrustLevel,
				})
				return {
					ok: true,
					grant: toPackageShareGrantLoaderView(
						await requireHydratedPackageShareGrantView({
							db: input.env.APP_DB,
							grant,
						}),
					),
				}
			}
			case 'revoke': {
				if (!grantId) {
					return { ok: false, error: 'grantId is required.', status: 400 }
				}
				const grant = await revokePackageShare({
					db: input.env.APP_DB,
					ownerUserId: input.user.mcpUser.userId,
					grantId,
				})
				return {
					ok: true,
					grant: toPackageShareGrantLoaderView(
						await requireHydratedPackageShareGrantView({
							db: input.env.APP_DB,
							grant,
						}),
					),
				}
			}
			case 'leave': {
				if (!grantId) {
					return { ok: false, error: 'grantId is required.', status: 400 }
				}
				const grant = await leavePackageShare({
					db: input.env.APP_DB,
					granteeUserId: input.user.mcpUser.userId,
					grantId,
				})
				return {
					ok: true,
					grant: toPackageShareGrantLoaderView(
						await requireHydratedPackageShareGrantView({
							db: input.env.APP_DB,
							grant,
						}),
					),
				}
			}
			case 'acknowledge': {
				if (!grantId) {
					return { ok: false, error: 'grantId is required.', status: 400 }
				}
				const switchToFollow = body['switchToFollow'] === true
				const expectedPublishedCommit =
					readString(body, 'publishedCommit') || undefined
				await assertSharePinAcknowledgeReview({
					env: input.env,
					db: input.env.APP_DB,
					granteeUserId: input.user.mcpUser.userId,
					grantId,
					switchToFollow,
					expectedPublishedCommit,
				})
				const grant = await acknowledgePackageShareUpdate({
					db: input.env.APP_DB,
					granteeUserId: input.user.mcpUser.userId,
					grantId,
					switchToFollow,
					expectedPublishedCommit,
				})
				return {
					ok: true,
					grant: toPackageShareGrantLoaderView(
						await requireHydratedPackageShareGrantView({
							db: input.env.APP_DB,
							grant,
						}),
					),
				}
			}
			default: {
				const exhaustive: never = intent
				return {
					ok: false,
					error: `Unhandled share action: ${String(exhaustive)}`,
					status: 400,
				}
			}
		}
	} catch (error) {
		const status = error instanceof PackageShareAccessError ? 400 : 500
		return {
			ok: false,
			error: packageShareAccessErrorMessage(error),
			status,
		}
	}
}
