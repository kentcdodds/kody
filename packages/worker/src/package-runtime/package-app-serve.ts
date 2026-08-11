import * as Sentry from '@sentry/cloudflare'
import { html } from 'remix/html-template'
import { createHtmlResponse } from 'remix/response/html'
import { type PackageAppMount } from '@kody-internal/shared/public-urls.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { getUsernameFormatValidationError } from '#worker/identity/username.ts'
import { getSavedPackageByKodyId } from '#worker/package-registry/repo.ts'
import {
	loadPackageManifestBySourceId,
	loadPackageSourceBySourceId,
} from '#worker/package-registry/source.ts'
import {
	buildPackageAppWorker,
	createPackageAppCallerContext,
} from '#worker/package-runtime/package-app.ts'
import {
	buildPackageAppNotFoundMessage,
	isPackageAppSyntheticRequest,
	packageAppSyntheticHeaderName,
	packageAppSyntheticHeaderValue,
	type PackageAppTrustedDispatch,
} from '#worker/package-runtime/package-app-synthetic.ts'
import { packageRealtimeSessionRpc } from '#worker/package-runtime/realtime-session.ts'
import { wantsJson } from '#worker/utils.ts'

export type PackageAppServeOwner = {
	userId: string
	username: string
	email: string
	displayName: string
}

export { type PackageAppMount }

export type PackageAppPath = {
	username: string
	kodyId: string
	restPath: string
	mount: PackageAppMount
}

export function parsePackageAppPath(pathname: string): PackageAppPath | null {
	const parts = pathname.split('/').filter(Boolean)
	const rawUsername = parts[0]?.startsWith('@') ? parts[0].slice(1) : ''
	if (!rawUsername || parts[1] !== 'packages') return null
	const rawKodyId = parts[2]?.trim()
	if (!rawKodyId) return null
	let username: string
	let kodyId: string
	try {
		username = decodeURIComponent(rawUsername)
		kodyId = decodeURIComponent(rawKodyId)
	} catch {
		return null
	}
	if (getUsernameFormatValidationError(username)) return null
	return {
		username,
		kodyId,
		restPath: parts.length > 3 ? `/${parts.slice(3).join('/')}` : '/',
		mount: 'username-path',
	}
}

/**
 * Parse the path shape served on a per-user package-app subdomain, where the
 * username comes from the hostname and the path is `/packages/{kodyId}/{rest}`.
 * The caller must already have validated the subdomain's username label.
 */
export function parsePackageAppSubdomainPath(input: {
	pathname: string
	username: string
}): PackageAppPath | null {
	const parts = input.pathname.split('/').filter(Boolean)
	if (parts[0] !== 'packages') return null
	const rawKodyId = parts[1]?.trim()
	if (!rawKodyId) return null
	let kodyId: string
	try {
		kodyId = decodeURIComponent(rawKodyId)
	} catch {
		return null
	}
	return {
		username: input.username,
		kodyId,
		restPath: parts.length > 2 ? `/${parts.slice(2).join('/')}` : '/',
		mount: 'user-subdomain',
	}
}

export function isPackageAppRequestPath(pathname: string) {
	return parsePackageAppPath(pathname) !== null
}

// Credentials that must never reach author-supplied package code. `Cookie`
// carries the owner's `kody_session`, `Authorization` carries MCP bearer tokens,
// and the `X-Kody-*` family is worker-internal auth (connector session keys and
// user ids). `Kody-Synthetic` is platform-only and must never be caller-controlled
// on public ingress. Stripping is unconditional as defense in depth and is also
// required for the non-production inline serving path.
const strippedPackageRequestHeaders = [
	'cookie',
	'authorization',
	'proxy-authorization',
	packageAppSyntheticHeaderName.toLowerCase(),
]

/**
 * Clone a request for package code with every credential header removed.
 *
 * Used for both the forwarded HTTP request and the realtime connect upgrade,
 * because the realtime `connect` hook receives the request headers too.
 */
export function createPackageCodeRequest(
	request: Request,
	url: string | URL = request.url,
) {
	const packageCodeRequest = new Request(url.toString(), request)
	for (const headerName of strippedPackageRequestHeaders) {
		packageCodeRequest.headers.delete(headerName)
	}
	for (const headerName of [...packageCodeRequest.headers.keys()]) {
		const normalized = headerName.toLowerCase()
		if (
			normalized.startsWith('x-kody-') ||
			normalized === packageAppSyntheticHeaderName.toLowerCase()
		) {
			packageCodeRequest.headers.delete(headerName)
		}
	}
	return packageCodeRequest
}

export function applyTrustedPackageAppDispatch(
	request: Request,
	dispatch: PackageAppTrustedDispatch | undefined,
) {
	if (dispatch?.synthetic !== true) {
		return request
	}
	const trustedRequest = new Request(request)
	trustedRequest.headers.set(
		packageAppSyntheticHeaderName,
		packageAppSyntheticHeaderValue,
	)
	return trustedRequest
}

function parsePackageRealtimePath(restPath: string) {
	const parts = restPath.split('/').filter(Boolean)
	if (parts[0] !== 'ws') return null
	if (parts.length > 2) return null
	const rawFacet = parts[1]?.trim() ?? ''
	if (!rawFacet) {
		return {
			facet: null,
		}
	}
	try {
		return {
			facet: decodeURIComponent(rawFacet),
		}
	} catch {
		return null
	}
}

function reportPackageAppFailure(input: {
	error: unknown
	phase: 'host-setup' | 'realtime-connect'
	requestUrl: URL
	kodyId: string
	packageId: string
	packageName: string
	sourceId: string
	forwardedPath: string
	realtimePath: string
}) {
	try {
		if (!Sentry.isInitialized()) return
		const client = Sentry.getClient()
		if (!client?.getOptions().dsn) return

		Sentry.withScope((scope) => {
			scope.setLevel('error')
			scope.setTag('package_app.phase', input.phase)
			scope.setTag('package_app.kody_id', input.kodyId)
			scope.setTag('package_app.package_id', input.packageId)
			scope.setTag('package_app.source_id', input.sourceId)
			scope.setContext('package_app', {
				phase: input.phase,
				kodyId: input.kodyId,
				packageId: input.packageId,
				packageName: input.packageName,
				sourceId: input.sourceId,
				forwardedPath: input.forwardedPath,
				realtimePath: input.realtimePath,
				hostPath: input.requestUrl.pathname,
			})
			Sentry.captureException(input.error)
		})
	} catch (sentryError) {
		console.warn('Failed to report package app failure to Sentry.', sentryError)
	}
}

type PackageAppFailureKind =
	| 'host-setup'
	| 'package-entrypoint'
	| 'realtime-connect'

function createPackageAppErrorResponse(input: {
	request: Request
	kind: PackageAppFailureKind
	kodyId: string
	packageName: string
}) {
	const messages = {
		'host-setup': {
			title: 'Package app could not be prepared',
			summary:
				'Kody could not load or prepare this package app runtime before your request reached the package code.',
			nextStep:
				'This has been reported to Kody. Try again shortly, or ask the package owner to republish the package if it keeps happening.',
		},
		'package-entrypoint': {
			title: 'Package app crashed',
			summary:
				'The package app started, but its own request handler failed while processing this request.',
			nextStep:
				'Ask the package owner to check recent runs for this app under Account → Activity.',
		},
		'realtime-connect': {
			title: 'Package realtime connection failed',
			summary:
				'Kody could not establish the realtime session for this package app.',
			nextStep:
				'This has been reported to Kody. Try reconnecting, or ask the package owner to retry after checking the package app.',
		},
	} satisfies Record<
		PackageAppFailureKind,
		{ title: string; summary: string; nextStep: string }
	>
	const message = messages[input.kind]
	const requestPath = new URL(input.request.url).pathname
	const body = {
		error: message.title,
		message: message.summary,
		next_step: message.nextStep,
		package: {
			name: input.packageName,
			kody_id: input.kodyId,
		},
		request_path: requestPath,
	}
	if (wantsJson(input.request)) {
		return Response.json(body, { status: 500 })
	}
	return createHtmlResponse(
		html`<!doctype html>
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>${message.title}</title>
					<style>
						:root {
							color-scheme: light dark;
							font-family:
								ui-sans-serif,
								system-ui,
								-apple-system,
								BlinkMacSystemFont,
								'Segoe UI',
								sans-serif;
							line-height: 1.5;
						}
						body {
							margin: 0;
							background: #f8fafc;
							color: #0f172a;
						}
						main {
							box-sizing: border-box;
							max-width: 46rem;
							margin: 0 auto;
							padding: min(12vh, 6rem) 1.25rem;
						}
						.card {
							border: 1px solid #cbd5e1;
							border-radius: 1rem;
							background: white;
							padding: clamp(1.25rem, 4vw, 2rem);
							box-shadow: 0 20px 60px rgb(15 23 42 / 0.12);
						}
						h1 {
							margin: 0 0 0.75rem;
							font-size: clamp(1.75rem, 4vw, 2.75rem);
							line-height: 1;
						}
						dl {
							display: grid;
							grid-template-columns: max-content 1fr;
							gap: 0.35rem 0.75rem;
							margin: 1.5rem 0 0;
						}
						dt {
							font-weight: 700;
						}
						@media (prefers-color-scheme: dark) {
							body {
								background: #020617;
								color: #e2e8f0;
							}
							.card {
								border-color: #334155;
								background: #0f172a;
							}
						}
					</style>
				</head>
				<body>
					<main>
						<section class="card" aria-labelledby="package-app-error-title">
							<h1 id="package-app-error-title">${message.title}</h1>
							<p>${message.summary}</p>
							<p>${message.nextStep}</p>
							<dl>
								<dt>Package</dt>
								<dd>${input.packageName}</dd>
								<dt>Kody ID</dt>
								<dd><code>${input.kodyId}</code></dd>
								<dt>Path</dt>
								<dd><code>${requestPath}</code></dd>
							</dl>
						</section>
					</main>
				</body>
			</html>`,
		{ status: 500 },
	)
}

/**
 * Serve a hosted package app for an already-authenticated owner.
 *
 * The owner is resolved by the caller because the package-app origin uses its
 * own host-scoped `kody_pkg_session` cookie, while the non-production inline
 * mode uses the `kody_session` cookie (see `package-app-origin.ts`).
 */
export async function servePackageAppRequest(input: {
	request: Request
	env: Env
	owner: PackageAppServeOwner
	packagePath: PackageAppPath
	dispatch?: PackageAppTrustedDispatch
}) {
	const { request, env, owner, packagePath, dispatch } = input
	const requestUrl = new URL(request.url)
	const { kodyId } = packagePath
	const packageRealtimeRestPath = packagePath.restPath
	const forwardedPackageRestPath = packagePath.restPath
	if (owner.username !== packagePath.username) {
		return new Response(buildPackageAppNotFoundMessage(), { status: 404 })
	}
	const savedPackage = await getSavedPackageByKodyId(env.APP_DB, {
		userId: owner.userId,
		kodyId,
	})
	if (!savedPackage || !savedPackage.hasApp) {
		return new Response(buildPackageAppNotFoundMessage(), { status: 404 })
	}
	const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
	const packageRealtimePath = parsePackageRealtimePath(packageRealtimeRestPath)
	if (packageRealtimePath && request.headers.get('Upgrade') === 'websocket') {
		try {
			return await packageRealtimeSessionRpc({
				env,
				userId: owner.userId,
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				sourceId: savedPackage.sourceId,
				baseUrl,
			}).connect(createPackageCodeRequest(request), packageRealtimePath.facet)
		} catch (error) {
			console.error('Package realtime handler failed:', error)
			reportPackageAppFailure({
				error,
				phase: 'realtime-connect',
				requestUrl,
				kodyId: savedPackage.kodyId,
				packageId: savedPackage.id,
				packageName: savedPackage.name,
				sourceId: savedPackage.sourceId,
				forwardedPath: forwardedPackageRestPath,
				realtimePath: packageRealtimeRestPath,
			})
			return createPackageAppErrorResponse({
				request,
				kind: 'realtime-connect',
				kodyId: savedPackage.kodyId,
				packageName: savedPackage.name,
			})
		}
	}

	let forwardedRequest: Request
	let entrypoint: { fetch(request: Request): Promise<Response> }
	try {
		const [packageManifest, callerContext] = await Promise.all([
			loadPackageManifestBySourceId({
				env,
				baseUrl,
				userId: owner.userId,
				sourceId: savedPackage.sourceId,
			}),
			createPackageAppCallerContext({
				baseUrl,
				user: {
					userId: owner.userId,
					email: owner.email,
					displayName: owner.displayName,
					username: owner.username,
				},
				packageId: savedPackage.id,
			}),
		])
		const appWorker = await buildPackageAppWorker({
			env,
			baseUrl,
			userId: owner.userId,
			savedPackage: {
				id: savedPackage.id,
				kodyId: savedPackage.kodyId,
				name: savedPackage.name,
				sourceId: savedPackage.sourceId,
				publishedCommit: packageManifest.source.published_commit,
				manifestPath: packageManifest.source.manifest_path,
				sourceRoot: packageManifest.source.source_root,
			},
			source: packageManifest.source,
			manifest: packageManifest.manifest,
			loadSourceFiles: async () => {
				const packageSource = await loadPackageSourceBySourceId({
					env,
					baseUrl,
					userId: owner.userId,
					sourceId: savedPackage.sourceId,
				})
				return packageSource.files
			},
			runtime: {
				callerContext,
				servingUsername: packagePath.username,
				hostedOrigin: requestUrl.origin,
				mount: packagePath.mount,
			},
		})
		entrypoint = appWorker.stub.getEntrypoint(appWorker.entrypointName)
		const forwardedUrl = new URL(requestUrl)
		forwardedUrl.pathname = forwardedPackageRestPath
		forwardedRequest = applyTrustedPackageAppDispatch(
			createPackageCodeRequest(request, forwardedUrl),
			dispatch,
		)
	} catch (error) {
		console.error('Package app handler failed:', error)
		reportPackageAppFailure({
			error,
			phase: 'host-setup',
			requestUrl,
			kodyId: savedPackage.kodyId,
			packageId: savedPackage.id,
			packageName: savedPackage.name,
			sourceId: savedPackage.sourceId,
			forwardedPath: forwardedPackageRestPath,
			realtimePath: packageRealtimeRestPath,
		})
		return createPackageAppErrorResponse({
			request,
			kind: 'host-setup',
			kodyId: savedPackage.kodyId,
			packageName: savedPackage.name,
		})
	}

	try {
		return await entrypoint.fetch(forwardedRequest)
	} catch (error) {
		console.error('Package app entrypoint failed:', error)
		return createPackageAppErrorResponse({
			request,
			kind: 'package-entrypoint',
			kodyId: savedPackage.kodyId,
			packageName: savedPackage.name,
		})
	}
}

export { isPackageAppSyntheticRequest }
