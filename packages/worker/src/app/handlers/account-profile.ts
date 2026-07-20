import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import {
	buildAccountProfilePayload,
	loadAccountProfileData,
} from '#app/account-profile-data.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getUniqueConstraintField } from '#app/database-errors.ts'
import { type routes } from '#app/routes.ts'
import { getUsernameValidationError, normalizeUsername } from '#app/username.ts'
import {
	republishCommunityListingsAfterUsernameChange,
	updatePackagesForUsernameChange,
} from '#worker/package-registry/username-change-packages.ts'
import { createDb, usersTable } from '#worker/db.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

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
				return jsonResponse(await loadAccountProfileData(user))
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const username = normalizeUsername(
				(body as Record<string, unknown>).username,
			)
			const usernameError = getUsernameValidationError(username)
			if (usernameError) {
				return jsonResponse({ ok: false, error: usernameError }, 400)
			}

			const requestIp = getRequestIp(request) ?? undefined
			const previousUsername = user.username
			if (username === previousUsername) {
				return jsonResponse(buildAccountProfilePayload(user))
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

			const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
			const packageUserId = user.mcpUser.userId

			// Claim the username first so concurrent renames lose on the unique
			// constraint before any package publishes use the new scope.
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

			let packageUpdate
			try {
				packageUpdate = await updatePackagesForUsernameChange({
					env,
					baseUrl,
					userId: packageUserId,
					previousUsername,
					nextUsername: username,
				})
			} catch (error) {
				try {
					await db.update(usersTable, user.userId, {
						username: previousUsername,
						updated_at: utcSqliteTimestamp(),
					})
				} catch (rollbackError) {
					console.error(
						JSON.stringify({
							message: 'username-change rollback failed after package error',
							userId: packageUserId,
							error: getErrorMessage(rollbackError),
						}),
					)
				}
				void logAuditEvent({
					category: 'account',
					action: 'update_username',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'package_scope_update_failed',
				})
				return jsonResponse(
					{
						ok: false,
						error: `Username was not changed because package updates failed: ${getErrorMessage(error)}`,
					},
					500,
				)
			}

			const communityPackageIds = packageUpdate.updatedPackages
				.filter((entry) => entry.shouldRepublishCommunityListing)
				.map((entry) => entry.packageId)
			const communityRepublish =
				communityPackageIds.length > 0
					? await republishCommunityListingsAfterUsernameChange({
							env,
							baseUrl,
							userId: packageUserId,
							packageIds: communityPackageIds,
						})
					: { republishedPackageIds: [], warnings: [] }

			void logAuditEvent({
				category: 'account',
				action: 'update_username',
				result: 'success',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
			})

			const packageCount = packageUpdate.updatedPackages.length
			const packageSummary =
				packageCount === 0
					? null
					: `Updated ${packageCount} package${packageCount === 1 ? '' : 's'} to the new @${username} scope.`
			const communityWarning =
				communityRepublish.warnings.length > 0
					? communityRepublish.warnings.join(' ')
					: null

			return jsonResponse({
				...buildAccountProfilePayload({
					...user,
					username,
					displayName: username,
					mcpUser: { ...user.mcpUser, displayName: username },
				} satisfies AuthenticatedUser),
				packagesUpdated: packageCount,
				communityListingsRepublished:
					communityRepublish.republishedPackageIds.length,
				...(packageSummary ? { packageUpdateMessage: packageSummary } : {}),
				...(communityWarning
					? { communityUpdateWarning: communityWarning }
					: {}),
			})
		},
	} satisfies Action<typeof routes.accountProfileApi>
}
