/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { z } from 'zod'
import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { handleFrameRequest } from '#app/frame-registry.ts'
import '#app/frame-registrations.ts'
import { loadProfileData } from '#app/profile-data.ts'
import { type routes } from '#app/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { CommunityActionError } from '#worker/community/errors.ts'
import {
	followCommunityUser,
	unfollowCommunityUser,
} from '#worker/community/social-service.ts'
import { jsonResponse } from '#worker/json-response.ts'

const followBodySchema = z.object({
	follow: z.boolean(),
})

export function createProfileHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const username = params.username
			const frameResponse = await handleFrameRequest(
				request,
				env,
				new URL(request.url).pathname,
			)
			if (frameResponse) return frameResponse

			const data = await loadProfileData(env, request, username)
			if (!data) {
				return renderAppPage({
					request,
					env,
					title: 'Profile unavailable',
					status: 404,
					loaderData: {
						profileShell: { ok: false, unavailable: true },
					},
				})
			}

			return renderAppPage({
				request,
				env,
				title: data.profile.displayName,
				loaderData: {
					profileShell: {
						ok: true,
						username: data.profile.username,
						displayName: data.profile.displayName,
						isSelf: data.isSelf,
						loggedIn: data.loggedIn,
						isFollowing: data.isFollowing,
						visibility: data.profile.visibility,
					},
				},
			})
		},
	} satisfies Action<typeof routes.profile>
}

export function createProfileApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const data = await loadProfileData(env, request, params.username)
			if (!data) {
				return jsonResponse(
					{ ok: false, error: "This profile isn't available." },
					404,
				)
			}
			return jsonResponse(data)
		},
	} satisfies Action<typeof routes.profileApi>
}

export function createProfileFollowApiPostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			const body = await request.json().catch(() => null)
			const parsed = followBodySchema.safeParse(body)
			if (!parsed.success) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			try {
				if (parsed.data.follow) {
					await followCommunityUser({
						env,
						followerUserId: user.mcpUser.userId,
						followeeUsername: params.username,
					})
				} else {
					await unfollowCommunityUser({
						env,
						followerUserId: user.mcpUser.userId,
						followeeUsername: params.username,
					})
				}
				return jsonResponse({ ok: true, following: parsed.data.follow })
			} catch (error) {
				if (error instanceof CommunityActionError) {
					return jsonResponse({ ok: false, error: error.message }, 400)
				}
				console.error('Profile follow update failed:', error)
				return jsonResponse(
					{ ok: false, error: 'Unable to update follow status.' },
					500,
				)
			}
		},
	} satisfies Action<typeof routes.profileFollowApiPost>
}
