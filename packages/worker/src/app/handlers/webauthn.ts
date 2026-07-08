import { jsonResponse } from '#worker/json-response.ts'
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { type Action } from 'remix/router'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import {
	createAuthCookie,
	destroyAuthCookie,
	isSecureRequest,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	createPasskey,
	findPasskeyById,
	listPasskeysForUser,
	updatePasskeyCounter,
} from '#app/passkeys.ts'
import { type routes } from '#app/routes.ts'
import { isTwoFactorEnabled } from '#app/two-factor.ts'
import {
	createVerifySessionCookie,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import {
	createWebAuthnChallengeCookie,
	destroyWebAuthnChallengeCookie,
	getWebAuthnConfig,
	readWebAuthnChallenge,
	setWebAuthnChallengeSecret,
} from '#app/webauthn.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { type AppEnv } from '#worker/env-schema.ts'

export function createWebauthnRegistrationHandler(appEnv: AppEnv) {
	const env = appEnv as unknown as Env

	return {
		middleware: [],
		async handler({ request, url }) {
			setWebAuthnChallengeSecret(appEnv.COOKIE_SECRET)
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			const config = getWebAuthnConfig(request)
			const secure = isSecureRequest(request)

			if (request.method === 'GET') {
				const existingPasskeys = await listPasskeysForUser(
					appEnv.APP_DB,
					user.userId,
				)
				const options = await generateRegistrationOptions({
					rpName: config.rpName,
					rpID: config.rpID,
					userName: user.username,
					userID: new TextEncoder().encode(String(user.userId)),
					userDisplayName: user.displayName || user.email,
					attestationType: 'none',
					excludeCredentials: existingPasskeys.map((passkey) => ({
						id: passkey.id,
					})),
					// Passkeys act as a full first factor here, so user verification
					// is required end-to-end (matching requireUserVerification below;
					// `preferred` could register credentials the server then rejects).
					authenticatorSelection: {
						residentKey: 'preferred',
						userVerification: 'required',
					},
				})

				return jsonResponse(
					{ ok: true, options },
					{
						headers: {
							'Set-Cookie': await createWebAuthnChallengeCookie(
								{
									challenge: options.challenge,
									webauthnUserId: options.user.id,
									userId: user.userId,
								},
								secure,
							),
						},
					},
				)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const requestIp = getRequestIp(request) ?? undefined
			const challengeData = await readWebAuthnChallenge(request)
			const clearChallengeCookie = await destroyWebAuthnChallengeCookie(secure)
			// The ceremony must complete for the same user it started for, so a
			// session swap between GET and POST can't bind the credential to the
			// wrong account.
			if (
				!challengeData?.webauthnUserId ||
				challengeData.userId !== user.userId
			) {
				return jsonResponse(
					{
						ok: false,
						error: 'Registration session expired. Please try again.',
					},
					{ status: 400, headers: { 'Set-Cookie': clearChallengeCookie } },
				)
			}

			const body = (await request.json().catch(() => null)) as {
				response?: RegistrationResponseJSON
			} | null
			if (!body?.response || typeof body.response !== 'object') {
				return jsonResponse(
					{ ok: false, error: 'Invalid registration response.' },
					{ status: 400, headers: { 'Set-Cookie': clearChallengeCookie } },
				)
			}

			let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>
			try {
				verification = await verifyRegistrationResponse({
					response: body.response,
					expectedChallenge: challengeData.challenge,
					expectedOrigin: config.origin,
					expectedRPID: config.rpID,
					requireUserVerification: true,
				})
			} catch (error) {
				void logAuditEvent({
					category: 'account',
					action: 'passkey_register',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'verification_error',
				})
				console.warn('Passkey registration verification failed:', error)
				return jsonResponse(
					{ ok: false, error: 'Passkey registration failed.' },
					{ status: 400, headers: { 'Set-Cookie': clearChallengeCookie } },
				)
			}

			if (!verification.verified || !verification.registrationInfo) {
				return jsonResponse(
					{ ok: false, error: 'Passkey registration failed.' },
					{ status: 400, headers: { 'Set-Cookie': clearChallengeCookie } },
				)
			}

			const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
				verification.registrationInfo

			const existingPasskey = await findPasskeyById(
				appEnv.APP_DB,
				credential.id,
			)
			if (existingPasskey) {
				return jsonResponse(
					{ ok: false, error: 'This passkey is already registered.' },
					{ status: 409, headers: { 'Set-Cookie': clearChallengeCookie } },
				)
			}

			await createPasskey(appEnv.APP_DB, {
				id: credential.id,
				aaguid,
				publicKey: isoBase64URL.fromBuffer(credential.publicKey),
				userId: user.userId,
				webauthnUserId: challengeData.webauthnUserId,
				counter: credential.counter,
				deviceType: credentialDeviceType,
				backedUp: credentialBackedUp,
				transports: credential.transports?.join(',') ?? null,
			})

			void logAuditEvent({
				category: 'account',
				action: 'passkey_register',
				result: 'success',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
			})
			return jsonResponse(
				{ ok: true },
				{ headers: { 'Set-Cookie': clearChallengeCookie } },
			)
		},
	} satisfies Action<typeof routes.webauthnRegistration>
}

export function createWebauthnAuthenticationHandler(appEnv: AppEnv) {
	const db = createDb(appEnv.APP_DB)

	return {
		middleware: [],
		async handler({ request, url }) {
			setWebAuthnChallengeSecret(appEnv.COOKIE_SECRET)
			setAuthSessionSecret(appEnv.COOKIE_SECRET)
			setVerifySessionSecret(appEnv.COOKIE_SECRET)

			const config = getWebAuthnConfig(request)
			const secure = isSecureRequest(request)

			if (request.method === 'GET') {
				const options = await generateAuthenticationOptions({
					rpID: config.rpID,
					userVerification: 'required',
				})
				return jsonResponse(
					{ ok: true, options },
					{
						headers: {
							'Set-Cookie': await createWebAuthnChallengeCookie(
								{ challenge: options.challenge },
								secure,
							),
						},
					},
				)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const requestIp = getRequestIp(request) ?? undefined
			const challengeData = await readWebAuthnChallenge(request)
			const clearChallengeCookie = await destroyWebAuthnChallengeCookie(secure)
			if (!challengeData) {
				return jsonResponse(
					{ ok: false, error: 'Sign-in session expired. Please try again.' },
					{ status: 400, headers: { 'Set-Cookie': clearChallengeCookie } },
				)
			}

			const body = (await request.json().catch(() => null)) as {
				response?: AuthenticationResponseJSON
				rememberMe?: unknown
			} | null
			if (!body?.response || typeof body.response !== 'object') {
				return jsonResponse(
					{ ok: false, error: 'Invalid authentication response.' },
					{ status: 400, headers: { 'Set-Cookie': clearChallengeCookie } },
				)
			}
			const rememberMe = body.rememberMe === true

			const passkey = await findPasskeyById(appEnv.APP_DB, body.response.id)
			if (!passkey) {
				void logAuditEvent({
					category: 'auth',
					action: 'passkey_login',
					result: 'failure',
					ip: requestIp,
					path: url.pathname,
					reason: 'unknown_passkey',
				})
				return jsonResponse(
					{ ok: false, error: 'Passkey not recognized.' },
					{ status: 401, headers: { 'Set-Cookie': clearChallengeCookie } },
				)
			}

			let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
			try {
				verification = await verifyAuthenticationResponse({
					response: body.response,
					expectedChallenge: challengeData.challenge,
					expectedOrigin: config.origin,
					expectedRPID: config.rpID,
					credential: {
						id: passkey.id,
						publicKey: isoBase64URL.toBuffer(passkey.public_key),
						counter: passkey.counter,
					},
					requireUserVerification: true,
				})
			} catch (error) {
				void logAuditEvent({
					category: 'auth',
					action: 'passkey_login',
					result: 'failure',
					ip: requestIp,
					path: url.pathname,
					reason: 'verification_error',
				})
				console.warn('Passkey authentication verification failed:', error)
				return jsonResponse(
					{ ok: false, error: 'Passkey sign-in failed.' },
					{ status: 401, headers: { 'Set-Cookie': clearChallengeCookie } },
				)
			}

			if (!verification.verified) {
				return jsonResponse(
					{ ok: false, error: 'Passkey sign-in failed.' },
					{ status: 401, headers: { 'Set-Cookie': clearChallengeCookie } },
				)
			}

			await updatePasskeyCounter(
				appEnv.APP_DB,
				passkey.id,
				verification.authenticationInfo.newCounter,
			)

			const userRecord = await db.findOne(usersTable, {
				where: { id: passkey.user_id },
			})
			if (!userRecord) {
				return jsonResponse(
					{ ok: false, error: 'Passkey sign-in failed.' },
					{ status: 401, headers: { 'Set-Cookie': clearChallengeCookie } },
				)
			}

			const headers = new Headers({
				'Cache-Control': 'no-store',
				'Content-Type': 'application/json; charset=utf-8',
			})
			headers.append('Set-Cookie', clearChallengeCookie)

			// Passkeys are an alternative first factor: accounts with TOTP
			// enabled still get the second-factor challenge (Epic Stack parity).
			if (await isTwoFactorEnabled(appEnv.APP_DB, userRecord.id)) {
				headers.append(
					'Set-Cookie',
					await createVerifySessionCookie(
						{
							id: String(userRecord.id),
							email: userRecord.email,
							rememberMe,
						},
						secure,
					),
				)
				// A pre-existing session must not stay usable while the second
				// factor is still pending for this new login.
				headers.append('Set-Cookie', await destroyAuthCookie(secure))
				void logAuditEvent({
					category: 'auth',
					action: 'login_2fa_challenge',
					result: 'success',
					email: userRecord.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'passkey',
				})
				return new Response(
					JSON.stringify({ ok: true, requiresTwoFactor: true }),
					{ status: 200, headers },
				)
			}

			headers.append(
				'Set-Cookie',
				await createAuthCookie(
					{
						id: String(userRecord.id),
						email: userRecord.email,
						rememberMe,
					},
					secure,
				),
			)
			void logAuditEvent({
				category: 'auth',
				action: 'passkey_login',
				result: 'success',
				email: userRecord.email,
				ip: requestIp,
				path: url.pathname,
			})
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers,
			})
		},
	} satisfies Action<typeof routes.webauthnAuthentication>
}
