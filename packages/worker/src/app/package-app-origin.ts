import { html } from 'remix/html-template'
import { createHtmlResponse } from 'remix/response/html'
import {
	buildPackageAppPath,
	buildPackageAppSubdomainUrl,
} from '@kody-internal/shared/public-urls.ts'
import {
	getAppBaseUrl,
	getPackageAppBaseUrl,
	getPackageAppOriginConfigurationError,
	parsePackageAppRequestHost,
} from '#worker/app-base-url.ts'
import { redirectToLoginWhenUnauthenticated } from '#app/auth-redirect.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { isSecureRequest } from '#app/auth-session.ts'
import {
	consumePackageAppHandoffToken,
	createPackageAppHandoffToken,
	packageAppHandoffQueryParam,
} from '#app/package-app-handoff.ts'
import { resolvePackageAppOwnerByStableUserId } from '#app/package-app-owner.ts'
import {
	createPackageAppSessionCookie,
	readPackageAppSession,
} from '#app/package-app-session.ts'
import {
	type PackageAppPath,
	parsePackageAppPath,
	parsePackageAppSubdomainPath,
	servePackageAppRequest,
} from '#app/handlers/package-app.ts'
import { buildUnmatchedPackageAppOriginPathMessage } from '#worker/package-runtime/package-app-synthetic.ts'
import { wantsJson } from '#worker/utils.ts'

/**
 * Host-based isolation for hosted package apps.
 *
 * Package apps execute author-supplied HTML/JS. If they were served from the app
 * origin, that code would be same-site with `kody_session`: a package page could
 * call first-party endpoints with the owner's credentials, and the owner's
 * cookie was forwarded into the package worker. Serving them from a separate
 * registrable domain (`PACKAGE_APP_BASE_URL`) makes them cross-site, so the
 * `SameSite=Lax` session cookie never attaches.
 *
 * Within that domain, every user gets their own subdomain
 * (`{username}.<package-app host>`), so one user's package apps are a
 * different origin from every other user's: browser state (cookies, storage,
 * `document` access) never crosses accounts. The bare package-app origin (the
 * apex) serves no package code at all — it only redirects legacy path-based
 * URLs to the owning user's subdomain and sends the bare origin home.
 *
 * The app origin is the only host that can authenticate the owner, so it mints
 * a short-lived single-use handoff token and the user's package-app subdomain
 * exchanges it for its own host-scoped session cookie (named with the
 * `__Host-` prefix on secure requests so sibling subdomains cannot shadow it).
 *
 * The origins never redirect to each other in a cycle: the app origin only
 * ever redirects *to* a package-app subdomain, the apex only redirects to a
 * subdomain or the app origin, and a subdomain only ever redirects within
 * itself (dropping a consumed token from the URL). A request that arrives
 * without a usable session gets a terminal 403 with a link back to the app
 * origin, so a browser that refuses the cookie fails visibly instead of
 * bouncing between hosts.
 *
 * `/@{username}/api/package-invocations/*`, `/@{username}/connectors/*`, and
 * `/@{username}/webhooks/*` deliberately stay on the app origin: they are
 * machine APIs authenticated by their own bearer tokens or shared secrets, they
 * are never called by package browser code, and moving them would widen the
 * package-app domain's surface for no benefit. They 404 here.
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

function createPackageAppOriginConfigurationErrorResponse(message: string) {
	return new Response(`Hosted package apps are unavailable. ${message}`, {
		status: 500,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

function createUnmatchedPackageAppPathResponse() {
	return new Response(buildUnmatchedPackageAppOriginPathMessage(), {
		status: 404,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

/**
 * The subdomain URL a package-app path is canonically served from, carrying
 * over the request's query string (minus any handoff token).
 */
function buildSubdomainTarget(input: {
	packageAppOrigin: string
	packagePath: PackageAppPath
	url: URL
}) {
	const target = new URL(
		buildPackageAppSubdomainUrl({
			packageAppOrigin: input.packageAppOrigin,
			username: input.packagePath.username,
			kodyId: input.packagePath.kodyId,
			restPath:
				input.packagePath.restPath === '/' ? null : input.packagePath.restPath,
		}),
	)
	target.search = withoutHandoffToken(input.url).search
	return target
}

/**
 * The app-origin entry URL for a package app: the path-based mount that
 * authenticates the owner and starts a fresh handoff.
 */
function buildAppOriginEntryUrl(input: {
	appBaseUrl: string
	packagePath: PackageAppPath
	url: URL
}) {
	const entry = new URL(
		`${input.appBaseUrl.replace(/\/+$/, '')}${buildPackageAppPath({
			username: input.packagePath.username,
			kodyId: input.packagePath.kodyId,
			restPath:
				input.packagePath.restPath === '/' ? null : input.packagePath.restPath,
		})}`,
	)
	entry.search = withoutHandoffToken(input.url).search
	return entry
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
					<style>
						:root {
							color-scheme: light dark;
							font-family: ui-sans-serif, system-ui, sans-serif;
							line-height: 1.5;
						}
						main {
							box-sizing: border-box;
							max-width: 34rem;
							margin: 0 auto;
							padding: min(12vh, 6rem) 1.25rem;
						}
					</style>
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

/**
 * Mint a handoff token for the signed-in owner and send them to their
 * package-app subdomain. The app origin never executes package code once
 * `PACKAGE_APP_BASE_URL` is configured.
 */
async function redirectAppOriginToPackageAppOrigin(input: {
	request: Request
	env: Env
	url: URL
	packagePath: PackageAppPath
	packageAppOrigin: string
}) {
	const { request, env, url, packagePath, packageAppOrigin } = input
	const target = buildSubdomainTarget({ packageAppOrigin, packagePath, url })

	// A non-safe method reaching the app origin is not part of the normal flow
	// (package pages are loaded from, and post back to, the package-app
	// subdomain). Preserve the method and let the subdomain authorize it with
	// its own session rather than minting a token for a request we cannot
	// replay.
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return redirectResponse({ location: target.toString(), status: 307 })
	}

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
				stableUserId: user.mcpUser.userId,
				username: user.username,
				kodyId: packagePath.kodyId,
			},
		}),
	)
	return redirectResponse({ location: target.toString(), status: 302 })
}

/**
 * The bare package-app origin serves no package code: it sends the bare origin
 * home and redirects legacy path-based package URLs to the owning user's
 * subdomain. Everything else fails closed.
 */
function handleApexRequest(input: {
	request: Request
	env: Env
	url: URL
	packagePath: PackageAppPath | null
	packageAppOrigin: string
}) {
	const { request, env, url, packagePath, packageAppOrigin } = input
	if (packagePath) {
		const target = buildSubdomainTarget({ packageAppOrigin, packagePath, url })
		return redirectResponse({
			location: target.toString(),
			status: request.method === 'GET' || request.method === 'HEAD' ? 302 : 307,
		})
	}
	if (url.pathname === '/') {
		return redirectResponse({
			location: `${getAppBaseUrl({ env })}/`,
			status: 302,
		})
	}
	return createUnmatchedPackageAppPathResponse()
}

async function handleUserSubdomainRequest(input: {
	request: Request
	env: Env
	url: URL
	username: string
}) {
	const { request, env, url, username } = input
	const appBaseUrl = getAppBaseUrl({ env })
	const packagePath = parsePackageAppSubdomainPath({
		pathname: url.pathname,
		username,
	})

	if (!packagePath) {
		// Nothing first-party is reachable here. The bare subdomain is a
		// plausible typo or bookmark, so send it home; everything else fails
		// closed.
		if (url.pathname === '/') {
			return redirectResponse({ location: `${appBaseUrl}/`, status: 302 })
		}
		return createUnmatchedPackageAppPathResponse()
	}

	// Sibling package-app subdomains are same-site, so until the package-app
	// domain is on the Public Suffix List a `SameSite=Lax` session cookie still
	// attaches to their cross-origin requests. A browser that holds sessions
	// for two accounts (shared machine, multiple sign-ins) could therefore let
	// one user's package code send a credentialed mutating request to another
	// user's app — CORS blocks the response, not the side effect. Mutating
	// browser requests must originate from this subdomain itself; requests
	// without an `Origin` header (non-browser clients, synthetic dispatch)
	// authenticate through their own paths and are unaffected.
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		const originHeader = request.headers.get('Origin')
		if (originHeader !== null && originHeader !== url.origin) {
			return new Response(
				'Cross-origin mutating requests to a package-app subdomain are not allowed.',
				{
					status: 403,
					headers: {
						'Cache-Control': 'no-store',
						'Content-Type': 'text/plain; charset=utf-8',
					},
				},
			)
		}
	}

	const handoffToken = url.searchParams.get(packageAppHandoffQueryParam)
	if (handoffToken) {
		const claims = await consumePackageAppHandoffToken({
			env,
			token: handoffToken,
			expected: {
				username: packagePath.username,
				kodyId: packagePath.kodyId,
			},
		})
		if (claims) {
			return redirectResponse({
				location: withoutHandoffToken(url).toString(),
				status: 302,
				setCookie: await createPackageAppSessionCookie({
					env,
					session: {
						stableUserId: claims.stableUserId,
						username: claims.username,
					},
					secure: isSecureRequest(request),
				}),
			})
		}
	}

	const parsedSession = await readPackageAppSession({ request, env })
	const owner = parsedSession
		? await resolvePackageAppOwnerByStableUserId({
				env,
				stableUserId: parsedSession.session.stableUserId,
				issuedAt: parsedSession.issuedAt,
			})
		: null

	if (!owner) {
		return createPackageAppSessionRequiredResponse({
			request,
			appOriginUrl: buildAppOriginEntryUrl({ appBaseUrl, packagePath, url }),
		})
	}

	// A token that reaches here is stale, forged, or for another package, so it is
	// still worthless — but it is still an internal auth artifact, and package code
	// has no business seeing one. Serve the request as if it never carried a
	// token, including when the parameter is present but empty.
	return await servePackageAppRequest({
		request: url.searchParams.has(packageAppHandoffQueryParam)
			? new Request(withoutHandoffToken(url), request)
			: request,
		env,
		owner,
		packagePath,
	})
}

/**
 * Route a request according to the configured package-app origin.
 *
 * Returns `null` when a non-production deployment has no separate package-app
 * origin, or when the request is ordinary first-party traffic on the app origin.
 * A production package-app request with unsafe origin configuration fails closed.
 */
export async function handlePackageAppOriginRequest(
	request: Request,
	env: Env,
) {
	const url = new URL(request.url)
	const requestHost = parsePackageAppRequestHost({ env, url })
	const packagePath = parsePackageAppPath(url.pathname)
	const configurationError = getPackageAppOriginConfigurationError(env)
	if (configurationError && (packagePath || requestHost)) {
		return createPackageAppOriginConfigurationErrorResponse(configurationError)
	}

	const packageAppOrigin = getPackageAppBaseUrl({ env })
	if (!packageAppOrigin) return null

	if (requestHost) {
		switch (requestHost.kind) {
			case 'apex':
				return handleApexRequest({
					request,
					env,
					url,
					packagePath,
					packageAppOrigin,
				})
			case 'user-subdomain':
				return await handleUserSubdomainRequest({
					request,
					env,
					url,
					username: requestHost.username,
				})
			case 'unrecognized-subdomain':
				return createUnmatchedPackageAppPathResponse()
			default: {
				requestHost satisfies never
				return createUnmatchedPackageAppPathResponse()
			}
		}
	}
	if (!packagePath) return null

	return await redirectAppOriginToPackageAppOrigin({
		request,
		env,
		url,
		packagePath,
		packageAppOrigin,
	})
}
