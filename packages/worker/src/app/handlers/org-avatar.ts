import { type Action } from 'remix/router'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type routes } from '#universal/routes.ts'
import {
	getOrgAvatarObject,
	parseOrgAvatarCacheKey,
} from '#worker/orgs/org-avatar.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

const publicOrgAvatarCacheControl = 'public, max-age=31536000, immutable'
const privateOrgAvatarCacheControl = 'private, no-store'

export function createOrgAvatarHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const row = await env.APP_DB.prepare(
				`SELECT id, avatar_key, profile_visibility
				 FROM orgs
				 WHERE slug = ?${andLiveDeletedAtSql()}`,
			)
				.bind(params.orgSlug.trim().toLowerCase())
				.first<{
					id: string
					avatar_key: string | null
					profile_visibility: string | null
				}>()
			if (!row?.avatar_key) {
				return new Response('Not found', { status: 404 })
			}

			const cacheKey = parseOrgAvatarCacheKey(row.avatar_key)
			if (!cacheKey || cacheKey !== `${params.hash}.${params.ext}`) {
				return new Response('Not found', { status: 404 })
			}

			const isPublic = row.profile_visibility !== 'private'
			if (!isPublic) {
				const user = await readAuthenticatedAppUser(request, env)
				const binding = user
					? await loadOrgBindingForSlug(
							env.APP_DB,
							user.mcpUser.userId,
							params.orgSlug,
						)
					: null
				if (!user || !binding || binding.org.id !== ownerIdFromStored(row.id)) {
					return new Response('Not found', { status: 404 })
				}
			}

			const object = await getOrgAvatarObject({
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
					? publicOrgAvatarCacheControl
					: privateOrgAvatarCacheControl,
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
	} satisfies Action<typeof routes.orgAvatar>
}
