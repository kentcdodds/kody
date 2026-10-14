import { credentialRedirectFor } from '#universal/credential-redirects.ts'

type RedirectableHandler<Context extends { request: Request }> = {
	middleware: Array<never>
	handler: (ctx: Context) => Promise<Response>
}

/**
 * The old Secrets, Integrations, and MCP servers index pages move to the
 * Credentials list, and the legacy `/connect/secret-set` intake opens the Key
 * form. Deeper paths (approvals, OAuth authorize) still reach `inner`, and
 * `/connect/secret-set` keeps its `inner` wired until that intake is removed.
 * Wrap a route only once the Credentials list has shipped and been proven and
 * nothing on it links back to that index, or the visit loops.
 */
export function withCredentialIndexRedirect<
	Context extends { request: Request },
	Handler extends RedirectableHandler<Context>,
>(inner: Handler & RedirectableHandler<Context>): Handler {
	return {
		...inner,
		async handler(ctx: Context) {
			const location = credentialRedirectFor(new URL(ctx.request.url))
			if (!location) return inner.handler(ctx)
			return new Response(null, {
				status: 302,
				headers: { Location: location, 'Cache-Control': 'private, no-store' },
			})
		},
	}
}
