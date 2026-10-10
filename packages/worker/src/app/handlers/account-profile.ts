import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { loadAccountProfileData } from '#app/account-profile-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type ProfileVisibility } from '#universal/loader-data.ts'
import { type routes } from '#universal/routes.ts'
import {
	normalizeUsername,
	usernamePermanentError,
} from '#worker/identity/username.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { updateCommunityProfile } from '#worker/community/profile-service.ts'

function readOptionalString(
	body: Record<string, unknown>,
	key: string,
): string | undefined {
	if (!(key in body)) return undefined
	const value = body[key]
	if (value === null) return ''
	if (typeof value !== 'string') return undefined
	return value
}

function readProfileVisibility(
	body: Record<string, unknown>,
): ProfileVisibility | undefined | 'invalid' {
	if (!('profileVisibility' in body)) return undefined
	const value = body.profileVisibility
	if (value === 'public' || value === 'private') return value
	return 'invalid'
}

export function createAccountProfileApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(await loadAccountProfileData(user, env))
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const record = body as Record<string, unknown>
			const hasUsername = 'username' in record
			const displayName = readOptionalString(record, 'displayName')
			const bio = readOptionalString(record, 'bio')
			const profileVisibility = readProfileVisibility(record)
			const hasProfileFields =
				displayName !== undefined ||
				bio !== undefined ||
				profileVisibility !== undefined

			if (!hasUsername && !hasProfileFields) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			if (profileVisibility === 'invalid') {
				return jsonResponse(
					{ ok: false, error: 'Profile visibility is invalid.' },
					400,
				)
			}

			const requestIp = getRequestIp(request) ?? undefined

			// An unchanged username is a no-op so accounts with grandfathered (e.g.
			// reserved) usernames can still save display name, bio, and visibility
			// from the combined form. Any other username is a rename, and usernames
			// are permanent.
			if (hasUsername && normalizeUsername(record.username) !== user.username) {
				return jsonResponse({ ok: false, error: usernamePermanentError }, 400)
			}

			if (hasProfileFields) {
				try {
					await updateCommunityProfile({
						env,
						numericUserId: user.userId,
						...(displayName !== undefined ? { displayName } : {}),
						...(bio !== undefined ? { bio } : {}),
						...(profileVisibility !== undefined
							? { visibility: profileVisibility }
							: {}),
					})
				} catch (error) {
					if (error instanceof CommunityActionError) {
						return jsonResponse({ ok: false, error: error.message }, 400)
					}
					throw error
				}

				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'update_profile',
					result: 'success',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
				})
			}

			return jsonResponse(await loadAccountProfileData(user, env))
		},
	} satisfies Action<typeof routes.accountProfileApi>
}
