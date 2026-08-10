import { type Action } from 'remix/router'
import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import {
	hasAlternativeBuiltInApp,
	hasStoredConnectClientSecret,
	loadAccountIntegrationByName,
	loadExistingConnectionSummary,
} from '#app/account-integrations-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requirePageSession } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { joinAppUrl } from '#worker/app-base-url.ts'
import { type ConnectOauthLoaderData } from '#universal/loader-data.ts'
import { type routes } from '#universal/routes.ts'

/**
 * Every working visit to /connect/oauth carries at least one of these:
 * `provider` (agent-built setup URLs and built-in connects), `code` (the
 * provider's success redirect — config is restored from sessionStorage, so
 * the query has no provider), or `error` (the provider's denial redirect).
 * A visit with none of them has no flow to resume — someone typed the URL
 * or followed a bare link — so the OAuth guide is the useful destination.
 * Checked before the session gate: the guide is public.
 */
export function isBareConnectOauthVisit(url: URL): boolean {
	const params = url.searchParams
	return !params.get('provider') && !params.get('code') && !params.get('error')
}

/**
 * SSR prefill embedded for every rendered visit so the page paints its final
 * layout server-side. `?provider=` visits carry the same record the
 * `/account/integrations.json?name=` endpoint serves (plus whether the
 * client-secret secret already exists), so a direct navigation renders (and
 * auto-starts built-ins) without a client fetch. Callback returns
 * (`code`/`error`) restore config from sessionStorage, so their query
 * carries no provider and only the redirect URI is embedded.
 */
async function loadConnectOauthLoaderData(
	env: Env,
	request: Request,
	requestUrl: URL,
): Promise<ConnectOauthLoaderData> {
	const redirectUri = joinAppUrl({
		env,
		path: requestUrl.pathname,
		requestUrl: request.url,
	})
	const provider = requestUrl.searchParams.get('provider')?.trim()
	const providerKey = provider ? normalizeProviderKey(provider) : ''
	if (!providerKey) {
		return { ok: true, provider: null, integration: null, redirectUri }
	}
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		return { ok: true, provider: null, integration: null, redirectUri }
	}
	// `platform=1` forces the built-in of the same name; `platform=<slug>`
	// connects that built-in under a different connection name.
	const platformParam = requestUrl.searchParams.get('platform')?.trim()
	const integration = await loadAccountIntegrationByName(
		env,
		user,
		providerKey,
		{
			preferPlatform: platformParam === '1',
			platformSlug:
				platformParam && platformParam !== '1'
					? (normalizeProviderKey(platformParam) ?? undefined)
					: undefined,
		},
	)
	const [builtInAvailable, existingConnection, hasStoredClientSecret] =
		await Promise.all([
			hasAlternativeBuiltInApp(env, providerKey, integration),
			loadExistingConnectionSummary(env, user, providerKey),
			hasStoredConnectClientSecret(env, user, providerKey, integration),
		])
	return {
		ok: true,
		provider: providerKey,
		integration,
		builtInAvailable,
		existingConnection,
		hasStoredClientSecret,
		redirectUri,
	}
}

export function createConnectOauthHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const requestUrl = new URL(request.url)
			if (isBareConnectOauthVisit(requestUrl)) {
				return Response.redirect(new URL('/guides/oauth', requestUrl), 302)
			}
			const sessionRedirect = await requirePageSession(request)
			if (sessionRedirect) {
				return sessionRedirect
			}
			const connectOauth = await loadConnectOauthLoaderData(
				env,
				request,
				requestUrl,
			)
			return renderAppPage({
				request,
				env,
				title: 'Connect OAuth',
				loaderData: { connectOauth },
			})
		},
	} satisfies Action<typeof routes.connectOauth>
}
