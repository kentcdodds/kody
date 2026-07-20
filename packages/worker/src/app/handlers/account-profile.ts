import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import {
	buildAccountProfilePayload,
	loadAccountProfileData,
} from '#app/account-profile-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getUniqueConstraintField } from '#app/database-errors.ts'
import { type ProfileVisibility } from '#app/loader-data.ts'
import { type routes } from '#app/routes.ts'
import { getUsernameValidationError, normalizeUsername } from '#app/username.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { updateCommunityProfile } from '#worker/community/social-service.ts'
import { createDb, usersTable } from '#worker/db.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

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
	const db = createDb(env.APP_DB)

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
			let nextUsername = user.username
			let nextUser: AuthenticatedUser = user

			// An unchanged username is a no-op rather than a validated update so
			// accounts with grandfathered (e.g. reserved) usernames can still
			// save display name, bio, and visibility from the combined form.
			const username = hasUsername ? normalizeUsername(record.username) : ''
			const usernameChanged = hasUsername && username !== user.username

			if (usernameChanged) {
				const usernameError = getUsernameValidationError(username)
				if (usernameError) {
					return jsonResponse({ ok: false, error: usernameError }, 400)
				}

				const existingUsername = await db.findOne(usersTable, {
					where: { username },
				})
				if (existingUsername && existingUsername.id !== user.userId) {
					void logAuditEvent({
						category: 'account',
						action: 'update_username',
						result: 'failure',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
						reason: 'username_exists',
					})
					return jsonResponse(
						{ ok: false, error: 'Username already registered.' },
						409,
					)
				}

				try {
					await db.update(usersTable, user.userId, {
						username,
						updated_at: utcSqliteTimestamp(),
					})
				} catch (error) {
					if (getUniqueConstraintField(error) === 'username') {
						void logAuditEvent({
							category: 'account',
							action: 'update_username',
							result: 'failure',
							email: user.email,
							ip: requestIp,
							path: url.pathname,
							reason: 'username_exists',
						})
						return jsonResponse(
							{ ok: false, error: 'Username already registered.' },
							409,
						)
					}
					throw error
				}

				void logAuditEvent({
					category: 'account',
					action: 'update_username',
					result: 'success',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
				})

				nextUsername = username
				nextUser = {
					...user,
					username,
					displayName: username,
					mcpUser: { ...user.mcpUser, displayName: username },
				} satisfies AuthenticatedUser
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
					category: 'account',
					action: 'update_profile',
					result: 'success',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
				})
			}

			if (hasProfileFields || hasUsername) {
				return jsonResponse(await loadAccountProfileData(nextUser, env))
			}

			return jsonResponse(
				buildAccountProfilePayload({
					...nextUser,
					username: nextUsername,
				}),
			)
		},
	} satisfies Action<typeof routes.accountProfileApi>
}
