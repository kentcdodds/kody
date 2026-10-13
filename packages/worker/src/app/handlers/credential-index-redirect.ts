import { credentialRedirectFor } from '#universal/credential-redirects.ts'

type OrgSectionHandler = {
	middleware: Array<never>
	handler: (ctx: {
		request: Request
		params: { orgSlug?: string; rest?: string }
	}) => Promise<Response>
}

/**
 * The old Secrets, Integrations, and MCP servers index pages move to the
 * Credentials list. Their deeper paths (approvals, OAuth authorize) still
 * reach `inner`. Wrap a route only once the Credentials list has shipped and
 * been proven and nothing on it links back to that index, or the visit loops.
 */
export function withCredentialIndexRedirect<Handler extends OrgSectionHandler>(
	inner: Handler,
): Handler {
	return {
		...inner,
		async handler(ctx) {
			const location = credentialRedirectFor(new URL(ctx.request.url))
			if (!location) return inner.handler(ctx)
			return new Response(null, {
				status: 302,
				headers: { Location: location, 'Cache-Control': 'private, no-store' },
			})
		},
	}
}
