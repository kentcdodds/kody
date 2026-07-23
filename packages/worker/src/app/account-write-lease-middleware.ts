import { type Middleware } from 'remix/router'
import {
	AccountDeletionInProgressError,
	AccountWriteLeaseLostError,
	withAccountWriteLease,
} from './account-deletion-state.ts'
import { loadResolvedRequestAuth } from './request-auth-cache.ts'

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const mutatingGetPaths = new Set([
	'/account/mcp-servers/oauth/callback',
	'/account/billing/success',
	'/account/billing/portal',
])

function accountDeletingResponse(status: number) {
	return Response.json(
		{
			error: {
				code: 'account_deleting',
				message:
					'Account deletion is in progress; user-owned writes are disabled.',
			},
		},
		{ status },
	)
}

export function createAccountWriteLeaseMiddleware(env: Env): Middleware {
	return async ({ request, url }, next) => {
		const mutating =
			unsafeMethods.has(request.method) || mutatingGetPaths.has(url.pathname)
		if (!mutating || url.pathname === '/account/delete') return await next()
		const auth = await loadResolvedRequestAuth(request, env)
		if (!auth.user) return await next()
		if (auth.user.accountDeleting) return accountDeletingResponse(409)
		try {
			return await withAccountWriteLease({
				db: env.APP_DB,
				stableUserId: auth.user.mcpUser.userId,
				holder: `web:${request.method} ${url.pathname}`,
				write: next,
			})
		} catch (error) {
			if (error instanceof AccountDeletionInProgressError) {
				return accountDeletingResponse(409)
			}
			if (error instanceof AccountWriteLeaseLostError) {
				return accountDeletingResponse(503)
			}
			throw error
		}
	}
}
