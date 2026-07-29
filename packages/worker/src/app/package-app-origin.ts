import { html } from 'remix/html-template'
import { createHtmlResponse } from 'remix/response/html'
import { getAppBaseUrl, getPackageAppBaseUrl } from '#app/app-base-url.ts'
import { redirectToLoginWhenUnauthenticated } from '#app/auth-redirect.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { isSecureRequest } from '#app/auth-session.ts'
import {
	consumePackageAppHandoffToken,
	createPackageAppHandoffToken,
	packageAppHandoffQueryParam,
} from '#app/package-app-handoff.ts'
import { resolvePackageAppOwnerByUserId } from '#app/package-app-owner.ts'
import {
	createPackageAppSessionCookie,
	readPackageAppSession,
} from '#app/package-app-session.ts'
import {
	isPackageAppRequestPath,
	parsePackageAppPath,
	servePackageAppRequest,
} from '#app/handlers/package-app.ts'
import { wantsJson } from '#worker/utils.ts'

/**
 * Host-based isolation for hosted package apps.
 *
 * Package apps execute author-supplied HTML/JS. While they were served from the
 * app origin, that code was same-site with `kody_session`: a package page could
 * call first-party endpoints with the owner's credentials, and the owner's
 * cookie was forwarded into the package worker. Serving them from a separate
 * registrable domain (`PACKAGE_APP_BASE_URL`) makes them cross-site, so the
 * `SameSite=Lax` session cookie never attaches.
 *
 * That leaves the app origin as the only host that can authenticate the owner,
 * so it mints a short-lived single-use handoff token and the package-app origin
 * exchanges it for its own host-scoped session cookie.
 *
 * The two origins never redirect to each other in a cycle: the app origin only
 * ever redirects *to* the package-app origin, and the package-app origin only
 * ever redirects within itself (dropping a consumed token from the URL). A
 * request that arrives without a usable session gets a terminal 403 with a link
 * back to the app origin, so a browser that refuses the cookie fails visibly
 * instead of bouncing between hosts.
 *
 * `/@{username}/api/package-invocations/*`, `/@{username}/connectors/*`, and
 * `/@{username}/webhooks/*` deliberately stay on the app origin: they are
 * machine APIs authenticated by their own bearer tokens or shared secrets, they
 * are never called by package browser code, and moving them would widen the
 * package-app origin's surface for no benefit. They 404 here.
 */

function withoutHandoffToken(url: URL) {
	const cleaned = new URL(url)
	cleaned.searchParams.delete(packageAppHandoffQueryParam)
	return cleaned
}

function redirectResponse(input: {
	location: string
	status: 302 | 307
	setCookie?: string
}) {
	const headers = new Headers({
		Location: input.location,
		'Cache-Control': 'no-store',
	})
	if (input.setCookie) headers.append('Set-Cookie', input.setCookie)
	return new Response(null, { status: input.status, headers })
}

/**
 * Terminal response for a package-app request with no usable package-app
 * session. Deliberately not a redirect back to the app origin: only the visitor
 * can decide to start a new handoff, so a broken cookie cannot loop.
 */
function createPackageAppSessionRequiredResponse(input: {
	request: Request
	appOriginUrl: URL
}) {
	const openUrl = input.appOriginUrl.toString()
	if (wantsJson(input.request)) {
		return Response.json(
			{
				error: 'Package app session required',
				message:
					'Hosted package apps run on their own domain and need a Kody handoff before they can load.',
				next_step: `Open the app from Kody at ${openUrl}.`,
			},
			{ status: 403, headers: { 'Cache-Control': 'no-store' } },
		)
	}
	return createHtmlResponse(
		html`<!doctype html>
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>Open this package app from Kody</title>
				</head>
				<body>
					<main>
						<h1>Open this package app from Kody</h1>
						<p>
							Hosted package apps run on their own domain, so Kody has to hand
							off your signed-in session before this app can load.
						</p>
						<p><a href="${openUrl}">Continue to this app</a></p>
						<p>
							If you keep landing here, your browser is refusing this site's
							cookie. Allow cookies for this domain and try again.
						</p>
					</main>
				</body>
			</html>`,
		{ status: 403, headers: { 'Cache-Control': 'no-store' } },
	)
}

function replaceOrigin(input: { url: URL; origin: string }) {
	const target = new URL(input.url)
	const origin = new URL(input.origin)
	target.protocol = origin.protocol
	target.host = origin.host
	return target
}

/**
 * Mint a handoff token for the signed-in owner and send them to the package-app
 * origin. The app origin never executes package code once `PACKAGE_APP_BASE_URL`
 * is configured.
 */
async function redirectAppOriginToPackageAppOrigin(input: {
	request: Request
	env: Env
	url: URL
	packageAppOrigin: string
}) {
	const { request, env, url, packageAppOrigin } = input
	const target = replaceOrigin({
		url: withoutHandoffToken(url),
		origin: packageAppOrigin,
	})

	// A non-safe method reaching the app origin is not part of the normal flow
	// (package pages are loaded from, and post back to, the package-app origin).
	// Preserve the method and let the package-app origin authorize it with its
	// own session rather than minting a token for a request we cannot replay.
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return redirectResponse({ location: target.toString(), status: 307 })
	}

	const packagePath = parsePackageAppPath(url.pathname)
	if (!packagePath) return new Response('Not Found', { status: 404 })

	const user = await readAuthenticatedAppUser(request, env)
	if (!user) return await redirectToLoginWhenUnauthenticated(request, env)
	if (user.username !== packagePath.username) {
		return new Response('Saved package app not found.', { status: 404 })
	}

	target.searchParams.set(
		packageAppHandoffQueryParam,
		await createPackageAppHandoffToken({
			env,
			claims: {
				userId: String(user.userId),
				username: user.username,
				kodyId: packagePath.kodyId,
			},
		}),
	)
	return redirectResponse({ location: target.toString(), status: 302 })
}

async function handleRequestOnPackageAppOrigin(input: {
	request: Request
	env: Env
	url: URL
}) {
	const { request, env, url } = input
	const appBaseUrl = getAppBaseUrl({ env })

	const packagePath = parsePackageAppPath(url.pathname)
	if (!packagePath) {
		// Nothing first-party is reachable here. The bare origin is a plausible
		// typo or bookmark, so send it home; everything else fails closed.
		if (url.pathname === '/') {
			return redirectResponse({ location: `${appBaseUrl}/`, status: 302 })
		}
		return new Response('Not Found', { status: 404 })
	}

	const handoffToken = url.searchParams.get(packageAppHandoffQueryParam)
	if (handoffToken) {
		const claims = await consumePackageAppHandoffToken({
			env,
			token: handoffToken,
		})
		if (
			claims &&
			claims.username === packagePath.username &&
			claims.kodyId === packagePath.kodyId
		) {
			return redirectResponse({
				location: withoutHandoffToken(url).toString(),
				status: 302,
				setCookie: await createPackageAppSessionCookie({
					env,
					session: { userId: claims.userId, username: claims.username },
					secure: isSecureRequest(request),
				}),
			})
		}
	}

	const parsedSession = await readPackageAppSession({ request, env })
	const owner = parsedSession
		? await resolvePackageAppOwnerByUserId({
				env,
				userId: parsedSession.session.userId,
				issuedAt: parsedSession.issuedAt,
			})
		: null

	if (!owner) {
		return createPackageAppSessionRequiredResponse({
			request,
			appOriginUrl: replaceOrigin({
				url: withoutHandoffToken(url),
				origin: appBaseUrl,
			}),
		})
	}

	return await servePackageAppRequest({ request, env, owner, packagePath })
}

/**
 * Route a request according to the configured package-app origin.
 *
 * Returns `null` when the deployment has no separate package-app origin, or when
 * the request is ordinary first-party traffic on the app origin — both cases
 * fall through to the normal worker pipeline.
 */
export async function handlePackageAppOriginRequest(
	request: Request,
	env: Env,
) {
	const packageAppOrigin = getPackageAppBaseUrl({ env })
	if (!packageAppOrigin) return null

	const url = new URL(request.url)
	if (url.origin === packageAppOrigin) {
		return await handleRequestOnPackageAppOrigin({ request, env, url })
	}
	if (!isPackageAppRequestPath(url.pathname)) return null

	return await redirectAppOriginToPackageAppOrigin({
		request,
		env,
		url,
		packageAppOrigin,
	})
}
