/**
 * Pathnames owned by the Cloudflare OAuth provider wrapper (not Remix
 * `routes.ts` / `router.map`). Client SPA registries and document-head key
 * off these so authorize/callback shells stay aligned with the provider.
 */
export const oauthPaths = {
	authorize: '/oauth/authorize',
	authorizeInfo: '/oauth/authorize-info',
	token: '/oauth/token',
	register: '/oauth/register',
	callback: '/oauth/callback',
	apiPrefix: '/api/',
	discovery: '/.well-known/oauth-authorization-server',
} as const
