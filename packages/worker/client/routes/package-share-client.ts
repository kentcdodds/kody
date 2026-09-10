import { type PackageShareGrantLoaderView } from '#universal/package-share.ts'
import { routes } from '#universal/routes.ts'
import { readJson } from './account-approval-shared.ts'

export type PackageShareActionIntent =
	| 'invite'
	| 'accept'
	| 'revoke'
	| 'leave'
	| 'acknowledge'

export type PackageShareActionInput = {
	intent: PackageShareActionIntent
	grantId?: string
	packageId?: string
	username?: string
	email?: string
	trustLevel?: 'follow' | 'pin'
	switchToFollow?: boolean
}

export type PackageShareActionResult =
	| { status: 'ok'; grant: PackageShareGrantLoaderView }
	| { status: 'unauthorized' }
	| { status: 'error'; message: string }

export async function postPackageShareAction(
	input: PackageShareActionInput & {
		ownerUsername?: string
		kodyId?: string
	},
): Promise<PackageShareActionResult> {
	const href =
		input.ownerUsername && input.kodyId
			? routes.communityPackageShareApiPost.href({
					username: input.ownerUsername,
					kodyId: input.kodyId,
				})
			: routes.accountSharedApiPost.href()
	const response = await fetch(href, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		credentials: 'include',
		body: JSON.stringify({
			intent: input.intent,
			grantId: input.grantId,
			packageId: input.packageId,
			username: input.username,
			email: input.email,
			trustLevel: input.trustLevel,
			switchToFollow: input.switchToFollow,
		}),
	}).catch(() => null)
	if (!response) {
		return { status: 'error', message: 'Unable to update the share grant.' }
	}
	if (response.status === 401) return { status: 'unauthorized' }
	const payload = await readJson<{
		ok: boolean
		grant?: PackageShareGrantLoaderView
		error?: string
	}>(response)
	if (!response.ok || !payload?.ok || !payload.grant) {
		return {
			status: 'error',
			message: payload?.error ?? 'Unable to update the share grant.',
		}
	}
	return { status: 'ok', grant: payload.grant }
}
