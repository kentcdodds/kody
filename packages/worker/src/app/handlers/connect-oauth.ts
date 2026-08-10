import { type Action } from 'remix/router'
import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import { loadAccountIntegrationByName } from '#app/account-integrations-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requirePageSession } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
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
 * SSR prefill for `?provider=` visits: the same record the
 * `/account/integrations.json?name=` endpoint serves, embedded so a direct
 * navigation renders (and auto-starts built-ins) without a client fetch.
 * Callback returns (`code`/`error`) restore config from sessionStorage, so
 * their query carries no provider and nothing is loaded.
 */
async function loadConnectOauthLoaderData(
	env: Env,
	request: Request,
	requestUrl: URL,
): Promise<ConnectOauthLoaderData | null> {
	const provider = requestUrl.searchParams.get('provider')?.trim()
	if (!provider) return null
	const providerKey = normalizeProviderKey(provider)
	if (!providerKey) return null
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) return null
	return {
		ok: true,
		provider: providerKey,
		integration: await loadAccountIntegrationByName(env, user, providerKey),
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
				...(connectOauth ? { loaderData: { connectOauth } } : {}),
			})
		},
	} satisfies Action<typeof routes.connectOauth>
}
