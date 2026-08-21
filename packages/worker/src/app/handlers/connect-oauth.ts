import { type Action } from 'remix/router'
import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import {
	hasAlternativeBuiltInApp,
	hasStoredConnectClientSecret,
	loadAccountIntegrationByName,
	loadExistingConnectionSummary,
	readConnectOauthLookupOptions,
} from '#app/account-integrations-data.ts'
import { loadConnectOauthChooser } from '#app/connect-oauth-chooser.ts'
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
 * A visit with none of them is the signed-in provider chooser.
 */
export function isBareConnectOauthVisit(url: URL): boolean {
	const params = url.searchParams
	return !params.get('provider') && !params.get('code') && !params.get('error')
}

/**
 * SSR prefill embedded for every rendered visit so the page paints its final
 * layout server-side. `?provider=` visits carry the same record the
 * `/account/integrations.json?name=` endpoint serves (plus whether the
 * client-secret secret already exists), so a direct navigation renders the
 * ready connect card without a client fetch. Callback returns
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
		if (!isBareConnectOauthVisit(requestUrl)) {
			return { ok: true, provider: null, integration: null, redirectUri }
		}
		const user = await readAuthenticatedAppUser(request, env)
		return {
			ok: true,
			provider: null,
			integration: null,
			redirectUri,
			chooser: user
				? await loadConnectOauthChooser({
						env,
						userId: user.mcpUser.userId,
					})
				: { options: [] },
		}
	}
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		return { ok: true, provider: null, integration: null, redirectUri }
	}
	// `platform=1` forces the built-in of the same name; `platform=<slug>`
	// connects that built-in under a different connection name.
	// `app=<slug>` reuses a saved bring-your-own app under `provider`.
	const integration = await loadAccountIntegrationByName(
		env,
		user,
		providerKey,
		readConnectOauthLookupOptions(requestUrl.searchParams),
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
				loaderData: { connectOauth },
			})
		},
	} satisfies Action<typeof routes.connectOauth>
}
