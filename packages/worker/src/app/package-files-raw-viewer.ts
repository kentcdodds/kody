import { waitUntil } from 'cloudflare:workers'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { apiTokenScopeIncludes } from '#worker/api-tokens/scopes.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { authenticateApiRequest } from '#worker/open-api/authenticate.ts'
import { ApiError } from '#worker/open-api/errors.ts'

export type PackageFileRawViewer =
	/** No Authorization header: `loadPackagePage` reads the session cookie. */
	| { kind: 'session' }
	/** Valid `kody_at_` token; `user` is null when it lacks `package:read`. */
	| { kind: 'token'; user: McpUserContext | null }
	| { kind: 'invalid'; error: ApiError }

/**
 * Agents fetch raw files with the same scoped `kody_at_` API token they use
 * for the Open API and git. Account gates (verified email, suspension,
 * password change) come from `authenticateApiRequest`. A token without
 * `package:read` reads like an anonymous visitor, matching git clone.
 */
export async function resolvePackageFileRawViewer(input: {
	env: Env
	request: Request
}): Promise<PackageFileRawViewer> {
	if (!input.request.headers.get('Authorization')?.trim()) {
		return { kind: 'session' }
	}
	try {
		const context = await authenticateApiRequest({
			request: input.request,
			env: input.env,
			appOrigin: getAppBaseUrl({
				env: input.env,
				requestUrl: input.request.url,
			}),
			waitUntil,
		})
		const canReadPackages =
			context.principal.kind === 'token' &&
			apiTokenScopeIncludes(context.principal.token.scopes, 'package:read')
		return {
			kind: 'token',
			user: canReadPackages ? context.callerContext.user : null,
		}
	} catch (error) {
		if (error instanceof ApiError) return { kind: 'invalid', error }
		throw error
	}
}
