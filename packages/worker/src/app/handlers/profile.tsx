import { z } from 'zod'
import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { handleFrameRequest } from '#app/frame-registry.ts'
import '#app/frame-registrations.ts'
import { loadProfileData } from '#app/profile-data.ts'
import { type routes } from '#app/routes.ts'
import { normalizeRedirectTo } from '#app/safe-redirect.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { getUserAvatarObject } from '#worker/community/avatar.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import {
	followCommunityUser,
	getCommunityProfileByUsername,
	unfollowCommunityUser,
} from '#worker/community/social-service.ts'
import { type CommunityProfileRecord } from '#worker/community/types.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { parseOgTheme } from '#worker/og/palette.ts'

const followBodySchema = z.object({
	follow: z.boolean(),
})

function parseBooleanFormField(value: FormDataEntryValue | null) {
	if (typeof value !== 'string') return null
	if (value === 'true') return true
	if (value === 'false') return false
	return null
}

function readSafeReturnTo(value: FormDataEntryValue | null) {
	if (typeof value !== 'string') return null
	return normalizeRedirectTo(value)
}

function redirectWithFollowError(returnTo: string, message: string) {
	const url = new URL(returnTo, 'https://kody.invalid')
	url.searchParams.set('followError', message.slice(0, 200))
	return new Response(null, {
		status: 303,
		headers: { Location: `${url.pathname}${url.search}${url.hash}` },
	})
}

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
				loaderData: {
					profileShell: {
						ok: true,
						username: data.profile.username,
						displayName: data.profile.displayName,
						bio: data.profile.bio,
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

/**
 * Resolve a satori-safe data URI for the profile avatar. PNG and JPEG bytes
 * embed directly; WebP (unsupported by satori) and load failures fall back to
 * a null placeholder so the OG renderer can draw an initial-letter circle.
 */
async function loadProfileOgAvatarDataUri(input: {
	env: Env
	profile: CommunityProfileRecord
}): Promise<string | null> {
	if (!input.profile.avatarKey) return null

	try {
		const object = await getUserAvatarObject({
			env: input.env,
			avatarKey: input.profile.avatarKey,
		})
		if (!object) return null

		const contentType = object.httpMetadata?.contentType ?? ''
		if (contentType !== 'image/png' && contentType !== 'image/jpeg') {
			return null
		}

		const bytes = new Uint8Array(await object.arrayBuffer())
		return `data:${contentType};base64,${bytesToBase64(bytes)}`
	} catch (error) {
		console.error(
			'profile-og-avatar-load-failed',
			input.profile.username,
			error,
		)
		return null
	}
}

export function createProfileOgImageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const profile = await getCommunityProfileByUsername({
				env,
				username: params.username,
				includePrivate: false,
			})
			if (!profile) {
				return new Response('Not found', { status: 404 })
			}

			const avatarDataUri = await loadProfileOgAvatarDataUri({ env, profile })
			// `?theme=light` renders the pale variant; anything unrecognised
			// falls back to the default rather than erroring.
			const theme = parseOgTheme(new URL(request.url).searchParams.get('theme'))

			// Lazy import (sanctioned exception to the no-inline-imports rule):
			// the OG renderer pulls in satori and @resvg/resvg-wasm plus two wasm
			// binaries, which would otherwise bloat isolate cold starts for a
			// route that is only hit by social-media crawlers.
			const { renderProfileOgImage } =
				await import('#worker/community/profile-og-image.ts')
			const png = await renderProfileOgImage({
				displayName: profile.displayName,
				username: profile.username,
				bio: profile.bio,
				followerCount: profile.followerCount,
				publicPackageCount: profile.publicPackageCount,
				listingCount: profile.listingCount,
				avatarDataUri,
				theme,
			})

			return new Response(png, {
				status: 200,
				headers: {
					'Cache-Control': 'public, max-age=3600',
					'Content-Type': 'image/png',
				},
			})
		},
	} satisfies Action<typeof routes.profileOgImage>
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

			const contentType = request.headers.get('content-type') ?? ''
			let follow: boolean | null = null
			let returnTo: string | null = null
			if (contentType.includes('application/json')) {
				const body = await request.json().catch(() => null)
				const parsed = followBodySchema.safeParse(body)
				if (!parsed.success) {
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}
				follow = parsed.data.follow
			} else {
				const form = await request.formData().catch(() => null)
				if (!form) {
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}
				follow = parseBooleanFormField(form.get('follow'))
				returnTo = readSafeReturnTo(form.get('returnTo'))
				if (follow == null) {
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}
			}

			try {
				if (follow) {
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
				if (returnTo) {
					return new Response(null, {
						status: 303,
						headers: { Location: returnTo },
					})
				}
				return jsonResponse({ ok: true, following: follow })
			} catch (error) {
				if (error instanceof CommunityActionError) {
					if (returnTo) {
						return redirectWithFollowError(returnTo, error.message)
					}
					return jsonResponse({ ok: false, error: error.message }, 400)
				}
				console.error('Profile follow update failed:', error)
				if (returnTo) {
					return redirectWithFollowError(
						returnTo,
						'Unable to update follow status.',
					)
				}
				return jsonResponse(
					{ ok: false, error: 'Unable to update follow status.' },
					500,
				)
			}
		},
	} satisfies Action<typeof routes.profileFollowApiPost>
}
