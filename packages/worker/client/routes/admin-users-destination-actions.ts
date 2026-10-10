import { readJson } from '#client/routes/account-approval-shared.ts'
import { type AdminUsersMutationData } from '#universal/loader-data.ts'
import { buildAdminUsersApiRequestUrl } from './admin-users-shared.ts'

export async function postMarkEmailDestinationVerified(input: {
	href: string
	stableUserId: string
	destinationEmail: string
}): Promise<AdminUsersMutationData> {
	const response = await fetch(buildAdminUsersApiRequestUrl(input.href), {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		credentials: 'include',
		body: JSON.stringify({
			action: 'mark_email_destination_verified',
			stableUserId: input.stableUserId,
			destinationEmail: input.destinationEmail,
		}),
	})
	if (response.status === 401) {
		window.location.assign('/login')
		throw new Error('Unauthorized.')
	}
	const payload = await readJson<
		AdminUsersMutationData & { ok?: boolean; error?: string }
	>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error(payload?.error || 'Unable to mark destination verified.')
	}
	return payload
}
