import { PROFILE_TARGET } from '#app/profile-frame-constants.ts'
import { loadProfileData } from '#app/profile-data.ts'
import { renderProfileContentHtml } from '#app/profile-content.tsx'
import { registerFrame } from '#app/frame-registry.ts'
import { routes } from '#app/routes.ts'
import { createMatcher } from 'remix/route-pattern/match'

const profileMatcher = createMatcher(routes.profile.pattern)

registerFrame(PROFILE_TARGET, {
	route: routes.profile,
	render: async ({ request, env, url }) => {
		const username = profileMatcher.match(url)?.params.username
		if (!username) {
			return ''
		}
		const data = await loadProfileData(env, request, username)
		if (!data) {
			return ''
		}
		return renderProfileContentHtml({
			profile: data.profile,
			packages: data.packages,
			activity: data.activity,
			query: data.query,
			isSelf: data.isSelf,
		})
	},
})
