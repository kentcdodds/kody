import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type routes } from '#universal/routes.ts'
import {
	getUserAvatarObject,
	parseUserAvatarCacheKey,
} from '#worker/community/avatar.ts'
import { getUserSocialRowByUsername } from '#worker/community/social-repo.ts'
import { resolveUserStableId } from '#worker/user-id.ts'

const publicUserAvatarCacheControl = 'public, max-age=31536000, immutable'
const privateUserAvatarCacheControl = 'private, no-store'

export function createProfileAvatarHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const row = await getUserSocialRowByUsername(env.APP_DB, params.username)
			if (!row?.avatar_key) {
				return new Response('Not found', { status: 404 })
			}

			const cacheKey = parseUserAvatarCacheKey(row.avatar_key)
			if (!cacheKey || cacheKey !== params.cacheKey) {
				return new Response('Not found', { status: 404 })
			}

			const isPublic = row.profile_visibility === 'public'
			if (!isPublic) {
				const user = await readAuthenticatedAppUser(request, env)
				const ownerStableId = resolveUserStableId({
					stable_user_id: row.stable_user_id,
				})
				if (!user || user.mcpUser.userId !== ownerStableId) {
					return new Response('Not found', { status: 404 })
				}
			}

			const object = await getUserAvatarObject({
				env,
				avatarKey: row.avatar_key,
			})
			if (!object) {
				return new Response('Not found', { status: 404 })
			}

			const contentType =
				object.httpMetadata?.contentType ?? 'application/octet-stream'
			const headers: Record<string, string> = {
				'Cache-Control': isPublic
					? publicUserAvatarCacheControl
					: privateUserAvatarCacheControl,
				'Content-Type': contentType,
				'X-Content-Type-Options': 'nosniff',
			}
			if (object.size != null) {
				headers['Content-Length'] = String(object.size)
			}
			if (object.httpEtag) {
				headers.ETag = object.httpEtag
			}

			return new Response(object.body, { headers })
		},
	} satisfies Action<typeof routes.profileAvatar>
}
