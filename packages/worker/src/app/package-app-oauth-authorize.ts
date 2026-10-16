import {
	getAuthSessionExpiresAtMs,
	readParsedAuthSession,
} from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { mintPackageAppOauthCode } from '#app/package-app-oauth-codes.ts'
import { parsePackageAppOauthClientId } from '#app/package-app-oauth-client-id.ts'
import {
	findLivePackageAppOauthGrant,
	grantCoversScopes,
	upsertPackageAppOauthGrant,
} from '#app/package-app-oauth-grants.ts'
import { isAllowedPackageAppOauthRedirectUri } from '#app/package-app-oauth-redirect-uris.ts'
import {
	parsePackageAppOauthScopes,
	scopesIncludeEmail,
	type PackageAppOauthScope,
} from '#app/package-app-oauth-scopes.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import { getPkceValidationError } from '#worker/oauth-pkce.ts'
import { resolvePackageAppOrgOwnerByHandle } from '#app/package-app-owner.ts'
import { viewerCanExecutePackageApp } from '#app/package-viewer-access.ts'
import { resolveSavedPackageForPackageAppSlug } from '#worker/package-invocations/module-artifacts.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import { resolveDisplayName } from '#worker/identity/username.ts'
import { createHtmlResponse } from 'remix/response/html'
import { html } from 'remix/html-template'
import { redirectToLoginWhenUnauthenticated } from '#app/auth-redirect.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'

/**
 * App-origin authorize + consent for hosted package apps.
 *
 * Consent is skipped when the visitor owns the package org, already has
 * `app:execute` on that app, or holds a live grant covering the requested
 * scopes. Email always requires an explicit grant (or a prior email grant).
 */

function redirectWithError(input: {
	redirectUri: string | null
	state: string | null
	error: string
	description: string
}) {
	if (!input.redirectUri) {
		return new Response(`${input.error}: ${input.description}`, {
			status: 400,
			headers: {
				'Cache-Control': 'no-store',
				'Content-Type': 'text/plain; charset=utf-8',
			},
		})
	}
	const target = new URL(input.redirectUri)
	target.searchParams.set('error', input.error)
	target.searchParams.set('error_description', input.description)
	if (input.state) target.searchParams.set('state', input.state)
	return new Response(null, {
		status: 302,
		headers: {
			Location: target.toString(),
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
		},
	})
}

type AuthorizeQuery = {
	clientIdRaw: string | null
	redirectUri: string | null
	state: string | null
	codeChallenge: string | null
	codeChallengeMethod: string | null
	scopeRaw: string | null
	responseType: string | null
}

function readAuthorizeQuery(url: URL): AuthorizeQuery {
	return {
		clientIdRaw: url.searchParams.get('client_id'),
		redirectUri: url.searchParams.get('redirect_uri'),
		state: url.searchParams.get('state'),
		codeChallenge: url.searchParams.get('code_challenge'),
		codeChallengeMethod: url.searchParams.get('code_challenge_method'),
		scopeRaw: url.searchParams.get('scope'),
		responseType: url.searchParams.get('response_type'),
	}
}

async function shouldSkipConsent(input: {
	env: Env
	personId: string
	orgUsername: string
	kodyId: string
	scopes: ReadonlyArray<PackageAppOauthScope>
	viewer: Awaited<ReturnType<typeof readAuthenticatedAppUser>>
}): Promise<boolean> {
	if (!input.viewer) return false
	try {
		const org = await resolvePackageAppOrgOwnerByHandle({
			env: input.env,
			handle: input.orgUsername,
		})
		if (!org) return false

		const lookup = await resolveSavedPackageForPackageAppSlug({
			db: input.env.APP_DB,
			userId: org.userId,
			slug: input.kodyId,
		})
		const canExecute = await viewerCanExecutePackageApp({
			env: input.env,
			viewer: input.viewer.mcpUser,
			ownerId: org.userId,
			appId: lookup?.savedPackage.id ?? null,
		})
		const needsEmail = scopesIncludeEmail(input.scopes)
		if (canExecute && !needsEmail) return true
	} catch {
		// Fall through to grant lookup / consent when access tables are incomplete.
	}

	const grant = await findLivePackageAppOauthGrant({
		db: input.env.APP_DB,
		personId: input.personId,
		orgUsername: input.orgUsername,
		kodyId: input.kodyId,
	})
	if (grant && grantCoversScopes(grant, input.scopes)) return true
	return false
}

async function issueCodeAndRedirect(input: {
	env: Env
	request: Request
	personId: string
	username: string
	orgUsername: string
	kodyId: string
	redirectUri: string
	codeChallenge: string
	scopes: Array<PackageAppOauthScope>
	state: string | null
	recordGrant: boolean
}) {
	const parsedSession = await readParsedAuthSession(input.request)
	if (!parsedSession) {
		return await redirectToLoginWhenUnauthenticated(input.request, input.env)
	}
	if (input.recordGrant) {
		await upsertPackageAppOauthGrant({
			db: input.env.APP_DB,
			personId: input.personId,
			orgUsername: input.orgUsername,
			kodyId: input.kodyId,
			scopes: input.scopes,
		})
	}
	const minted = await mintPackageAppOauthCode({
		env: input.env,
		record: {
			personId: input.personId,
			username: input.username,
			orgUsername: input.orgUsername,
			kodyId: input.kodyId,
			redirectUri: input.redirectUri,
			codeChallenge: input.codeChallenge,
			scopes: input.scopes,
			sessionExpiresAt: getAuthSessionExpiresAtMs({
				rememberMe: parsedSession.session.rememberMe,
				issuedAt: parsedSession.issuedAt,
			}),
		},
	})
	if (!minted) {
		return new Response('Authorization code storage is unavailable.', {
			status: 503,
			headers: { 'Cache-Control': 'no-store' },
		})
	}
	const target = new URL(input.redirectUri)
	target.searchParams.set('code', minted.code)
	if (input.state) target.searchParams.set('state', input.state)
	return new Response(null, {
		status: 302,
		headers: {
			Location: target.toString(),
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
		},
	})
}

function renderConsentPage(input: {
	appTitle: string
	clientId: string
	orgUsername: string
	kodyId: string
	displayName: string
	scopes: ReadonlyArray<PackageAppOauthScope>
	authorizeAction: string
	hiddenFields: Record<string, string>
}) {
	const asksEmail = scopesIncludeEmail(input.scopes)
	return createHtmlResponse(
		html`<!doctype html>
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<meta name="referrer" content="no-referrer" />
					<title>Authorize ${input.appTitle} — Kody</title>
					<style>
						:root {
							color-scheme: light dark;
							--bg: #0f1419;
							--card: #1a222c;
							--ink: #f4f7fb;
							--muted: #9aa7b5;
							--line: #2a3542;
							--accent: #3d9cf0;
							--accent-ink: #041018;
							--danger: #f07178;
							font-family: 'Segoe UI', ui-sans-serif, system-ui, sans-serif;
							line-height: 1.45;
						}
						@media (prefers-color-scheme: light) {
							:root {
								--bg: #f3f6f9;
								--card: #ffffff;
								--ink: #14202b;
								--muted: #5b6b7a;
								--line: #d7e0ea;
								--accent: #0b6bcb;
								--accent-ink: #ffffff;
								--danger: #b42318;
							}
						}
						* {
							box-sizing: border-box;
						}
						body {
							margin: 0;
							min-height: 100vh;
							background:
								radial-gradient(
									1200px 600px at 10% -10%,
									color-mix(in oklab, var(--accent) 22%, transparent),
									transparent 60%
								),
								var(--bg);
							color: var(--ink);
						}
						main {
							width: min(28rem, calc(100% - 2rem));
							margin: 0 auto;
							padding: min(12vh, 5rem) 0 3rem;
						}
						.brand {
							font-size: 0.85rem;
							letter-spacing: 0.08em;
							text-transform: uppercase;
							color: var(--muted);
							margin: 0 0 0.75rem;
						}
						.card {
							background: var(--card);
							border: 1px solid var(--line);
							border-radius: 1rem;
							padding: 1.5rem;
							box-shadow: 0 18px 40px color-mix(in oklab, #000 18%, transparent);
						}
						h1 {
							font-size: 1.45rem;
							margin: 0 0 0.5rem;
							line-height: 1.25;
						}
						.lead {
							margin: 0 0 1.25rem;
							color: var(--muted);
						}
						ul {
							margin: 0 0 1.5rem;
							padding-left: 1.1rem;
							color: var(--ink);
						}
						li + li {
							margin-top: 0.35rem;
						}
						.actions {
							display: flex;
							flex-wrap: wrap;
							gap: 0.75rem;
						}
						button {
							appearance: none;
							border: 0;
							border-radius: 0.65rem;
							padding: 0.75rem 1.1rem;
							font: inherit;
							font-weight: 600;
							cursor: pointer;
							min-height: 48px;
						}
						.approve {
							background: var(--accent);
							color: var(--accent-ink);
						}
						.deny {
							background: transparent;
							color: var(--danger);
							border: 1px solid
								color-mix(in oklab, var(--danger) 45%, var(--line));
						}
						.meta {
							margin-top: 1.25rem;
							font-size: 0.85rem;
							color: var(--muted);
						}
						code {
							font-size: 0.9em;
						}
					</style>
				</head>
				<body>
					<main>
						<p class="brand">Kody</p>
						<section class="card" data-testid="package-app-oauth-consent">
							<h1>Allow ${input.appTitle} to use your Kody account?</h1>
							<p class="lead">
								Signed in as <strong>${input.displayName}</strong>. This app
								(<code>${input.clientId}</code>) is hosted on Kody.
							</p>
							<ul>
								<li>See your name, username, and avatar</li>
								<li>See your access level for this app</li>
								${asksEmail ? html`<li>See your email address</li>` : null}
							</ul>
							<form method="post" action="${input.authorizeAction}">
								<input
									type="hidden"
									name="client_id"
									value="${input.hiddenFields.client_id ?? ''}"
								/>
								<input
									type="hidden"
									name="redirect_uri"
									value="${input.hiddenFields.redirect_uri ?? ''}"
								/>
								<input
									type="hidden"
									name="response_type"
									value="${input.hiddenFields.response_type ?? 'code'}"
								/>
								<input
									type="hidden"
									name="code_challenge"
									value="${input.hiddenFields.code_challenge ?? ''}"
								/>
								<input
									type="hidden"
									name="code_challenge_method"
									value="${input.hiddenFields.code_challenge_method ?? 'S256'}"
								/>
								<input
									type="hidden"
									name="scope"
									value="${input.hiddenFields.scope ?? ''}"
								/>
								<input
									type="hidden"
									name="state"
									value="${input.hiddenFields.state ?? ''}"
								/>
								<div class="actions">
									<button
										class="approve"
										type="submit"
										name="decision"
										value="approve"
										data-testid="package-app-oauth-approve"
									>
										Allow
									</button>
									<button
										class="deny"
										type="submit"
										name="decision"
										value="deny"
										data-testid="package-app-oauth-deny"
									>
										Deny
									</button>
								</div>
							</form>
							<p class="meta">
								You can sign out of this app later from the app itself. Revoking
								access on kody.codes will stop new sessions.
							</p>
						</section>
					</main>
				</body>
			</html>`,
		{
			status: 200,
			headers: {
				'Cache-Control': 'no-store',
				'Referrer-Policy': 'no-referrer',
			},
		},
	)
}

async function parseAndValidateAuthorizeRequest(input: {
	env: Env
	query: AuthorizeQuery
}) {
	const client = parsePackageAppOauthClientId(input.query.clientIdRaw)
	if (!client) {
		return {
			ok: false as const,
			response: redirectWithError({
				redirectUri: null,
				state: input.query.state,
				error: 'invalid_client',
				description: 'client_id must be owner/leaf for a hosted package app.',
			}),
		}
	}
	// Allowlist redirect_uri before any error redirect that would use it —
	// otherwise unsupported_response_type becomes an open redirect.
	if (!input.query.redirectUri) {
		return {
			ok: false as const,
			response: redirectWithError({
				redirectUri: null,
				state: input.query.state,
				error: 'invalid_request',
				description: 'redirect_uri is required.',
			}),
		}
	}
	const allowed = await isAllowedPackageAppOauthRedirectUri({
		env: input.env,
		client,
		redirectUri: input.query.redirectUri,
	})
	if (!allowed) {
		return {
			ok: false as const,
			response: redirectWithError({
				redirectUri: null,
				state: input.query.state,
				error: 'invalid_request',
				description:
					'redirect_uri must be the /_kody/auth/callback on a verified origin for this package.',
			}),
		}
	}
	const safeRedirectUri = input.query.redirectUri
	if (input.query.responseType !== 'code') {
		return {
			ok: false as const,
			response: redirectWithError({
				redirectUri: safeRedirectUri,
				state: input.query.state,
				error: 'unsupported_response_type',
				description: 'response_type must be code.',
			}),
		}
	}
	const pkceError = getPkceValidationError({
		codeChallenge: input.query.codeChallenge ?? undefined,
		codeChallengeMethod: input.query.codeChallengeMethod ?? undefined,
	})
	if (pkceError || !input.query.codeChallenge) {
		return {
			ok: false as const,
			response: redirectWithError({
				redirectUri: safeRedirectUri,
				state: input.query.state,
				error: 'invalid_request',
				description: pkceError ?? 'PKCE code_challenge is required.',
			}),
		}
	}
	const { scopes, error: scopeError } = parsePackageAppOauthScopes(
		input.query.scopeRaw,
	)
	if (scopeError) {
		return {
			ok: false as const,
			response: redirectWithError({
				redirectUri: safeRedirectUri,
				state: input.query.state,
				error: 'invalid_scope',
				description: scopeError,
			}),
		}
	}
	return {
		ok: true as const,
		client,
		redirectUri: safeRedirectUri,
		state: input.query.state,
		codeChallenge: input.query.codeChallenge,
		scopes,
	}
}

function isSameOriginAuthorizePost(request: Request, env: Env) {
	const appOrigin = new URL(getAppBaseUrl({ env })).origin
	const origin = request.headers.get('Origin')
	if (origin) return origin === appOrigin
	const site = request.headers.get('Sec-Fetch-Site')
	if (site === 'same-origin' || site === 'none') return true
	// Non-browser clients (tests) omit both; require an explicit same-origin
	// Referer when Origin is absent and Sec-Fetch-Site is missing.
	const referer = request.headers.get('Referer')
	if (!referer) return false
	try {
		return new URL(referer).origin === appOrigin
	} catch {
		return false
	}
}

export async function handlePackageAppOauthAuthorizeRequest(
	request: Request,
	env: Env,
) {
	const url = new URL(request.url)
	if (url.pathname !== packageAppOauthPaths.authorize) {
		return new Response('Not found.', { status: 404 })
	}

	const query =
		request.method === 'POST'
			? await (async () => {
					const form = await request.formData()
					return {
						clientIdRaw: String(form.get('client_id') ?? ''),
						redirectUri: String(form.get('redirect_uri') ?? ''),
						state: String(form.get('state') ?? '') || null,
						codeChallenge: String(form.get('code_challenge') ?? ''),
						codeChallengeMethod: String(
							form.get('code_challenge_method') ?? 'S256',
						),
						scopeRaw: String(form.get('scope') ?? ''),
						responseType: String(form.get('response_type') ?? 'code'),
						decision: String(form.get('decision') ?? ''),
					}
				})()
			: { ...readAuthorizeQuery(url), decision: '' }

	const validated = await parseAndValidateAuthorizeRequest({
		env,
		query,
	})
	if (!validated.ok) return validated.response

	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		return await redirectToLoginWhenUnauthenticated(request, env)
	}

	if (request.method === 'POST') {
		if (!isSameOriginAuthorizePost(request, env)) {
			return new Response('Cross-origin consent posts are not allowed.', {
				status: 403,
				headers: { 'Cache-Control': 'no-store' },
			})
		}
		const decision = 'decision' in query ? query.decision : ''
		if (decision === 'deny') {
			return redirectWithError({
				redirectUri: validated.redirectUri,
				state: validated.state,
				error: 'access_denied',
				description: 'The user denied the request.',
			})
		}
		if (decision !== 'approve') {
			return redirectWithError({
				redirectUri: validated.redirectUri,
				state: validated.state,
				error: 'invalid_request',
				description: 'Unknown consent decision.',
			})
		}
		return await issueCodeAndRedirect({
			env,
			request,
			personId: user.mcpUser.userId,
			username: user.username,
			orgUsername: validated.client.username,
			kodyId: validated.client.kodyId,
			redirectUri: validated.redirectUri,
			codeChallenge: validated.codeChallenge,
			scopes: validated.scopes,
			state: validated.state,
			recordGrant: true,
		})
	}

	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method not allowed.', { status: 405 })
	}

	const skip = await shouldSkipConsent({
		env,
		personId: user.mcpUser.userId,
		orgUsername: validated.client.username,
		kodyId: validated.client.kodyId,
		scopes: validated.scopes,
		viewer: user,
	})
	if (skip) {
		return await issueCodeAndRedirect({
			env,
			request,
			personId: user.mcpUser.userId,
			username: user.username,
			orgUsername: validated.client.username,
			kodyId: validated.client.kodyId,
			redirectUri: validated.redirectUri,
			codeChallenge: validated.codeChallenge,
			scopes: validated.scopes,
			state: validated.state,
			recordGrant: false,
		})
	}

	let appTitle = validated.client.kodyId
	try {
		const org = await resolvePackageAppOrgOwnerByHandle({
			env,
			handle: validated.client.username,
		})
		const lookup = org
			? await resolveSavedPackageForPackageAppSlug({
					db: env.APP_DB,
					userId: org.userId,
					slug: validated.client.kodyId,
				})
			: null
		if (lookup) {
			appTitle = getPackageNameLeaf(lookup.savedPackage.name)
		}
	} catch {
		// Consent still renders when package metadata tables are unavailable.
	}

	const authorizeAction = packageAppOauthPaths.authorize
	return renderConsentPage({
		appTitle,
		clientId: validated.client.clientId,
		orgUsername: validated.client.username,
		kodyId: validated.client.kodyId,
		displayName:
			user.displayName ||
			resolveDisplayName({
				email: user.email,
				username: user.username,
			}),
		scopes: validated.scopes,
		authorizeAction,
		hiddenFields: {
			client_id: validated.client.clientId,
			redirect_uri: validated.redirectUri,
			response_type: 'code',
			code_challenge: validated.codeChallenge,
			code_challenge_method: 'S256',
			scope: validated.scopes.join(' '),
			...(validated.state ? { state: validated.state } : {}),
		},
	})
}
