import { type Action } from 'remix/router'
import { type routes } from '#universal/routes.ts'
import { jsonResponse } from '#worker/json-response.ts'

export function createCommunityTrustApiPostHandler(_env: Env) {
	return {
		middleware: [],
		async handler() {
			return jsonResponse(
				{
					ok: false,
					error: 'Trusted listings have been removed.',
				},
				410,
			)
		},
	} satisfies Action<typeof routes.communityTrustApiPost>
}
