import { type Action } from 'remix/router'
import { loadAccountProfileData } from '#app/account-profile-data.ts'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type routes } from '#app/routes.ts'
import {
	deleteUserAvatar,
	processUserAvatar,
	saveUserAvatar,
} from '#worker/community/avatar.ts'
import { jsonResponse } from '#worker/json-response.ts'

async function readFileBytes(file: File): Promise<Uint8Array> {
	return new Uint8Array(await file.arrayBuffer())
}

export function createAccountAvatarApiPostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const requestIp = getRequestIp(request) ?? undefined
			const contentType = request.headers.get('Content-Type') ?? ''

			if (contentType.includes('application/json')) {
				const body = await request.json().catch(() => null)
				if (
					!body ||
					typeof body !== 'object' ||
					(body as Record<string, unknown>).remove !== true
				) {
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}

				await deleteUserAvatar({
					env,
					numericUserId: user.userId,
					stableUserId: user.mcpUser.userId,
				})

				void logAuditEvent({
					category: 'account',
					action: 'delete_avatar',
					result: 'success',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
				})

				return jsonResponse(await loadAccountProfileData(user, env))
			}

			let formData: FormData
			try {
				formData = await request.formData()
			} catch {
				return jsonResponse(
					{
						ok: false,
						error: 'Expected multipart form data with an avatar file.',
					},
					400,
				)
			}

			const avatar = formData.get('avatar')
			if (!(avatar instanceof File) || avatar.size === 0) {
				return jsonResponse(
					{ ok: false, error: 'Avatar file is required.' },
					400,
				)
			}

			try {
				const sourceBytes = await readFileBytes(avatar)
				const processed = processUserAvatar({
					contentType: avatar.type || 'application/octet-stream',
					sourceBytes,
				})
				await saveUserAvatar({
					env,
					numericUserId: user.userId,
					stableUserId: user.mcpUser.userId,
					bytes: processed.bytes,
					contentType: processed.contentType,
				})
			} catch (error) {
				const message =
					error instanceof Error ? error.message : 'Unable to save avatar.'
				return jsonResponse({ ok: false, error: message }, 400)
			}

			void logAuditEvent({
				category: 'account',
				action: 'upload_avatar',
				result: 'success',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
			})

			return jsonResponse(await loadAccountProfileData(user, env))
		},
	} satisfies Action<typeof routes.accountAvatarApiPost>
}
