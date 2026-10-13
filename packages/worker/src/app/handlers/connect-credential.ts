import { type Action } from 'remix/router'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { orgCredentialCreatePath } from '#universal/credential-contracts.ts'
import { type routes } from '#universal/routes.ts'

/** The signup org's creation page, keeping `search` (including its `?`). */
export function signupOrgCredentialCreateHref(
	user: Pick<AuthenticatedAppUser, 'request' | 'username'>,
	search: string,
) {
	const slug = user.request.org.slug ?? user.username
	return `${orgCredentialCreatePath(slug)}${search}`
}

/**
 * `/connect/credential`: the org-less creation link. The page lives under
 * an org (`/@slug/-/credentials/new`), so this sends the person to their
 * signup org's page with the same query.
 */
export function createConnectCredentialHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}
			const { search } = new URL(request.url)
			return new Response(null, {
				status: 302,
				headers: {
					Location: signupOrgCredentialCreateHref(user, search),
					// The target depends on who is signed in.
					'Cache-Control': 'private, no-store',
				},
			})
		},
	} satisfies Action<typeof routes.connectCredential>
}
