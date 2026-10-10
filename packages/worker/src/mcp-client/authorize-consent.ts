import {
	base64UrlToBytes,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { orgSectionRestPath } from '#universal/org-section-hrefs.ts'

const consentTokenPurpose = 'kody-mcp-server-authorize-v1'

/**
 * The `authUrl` every MCP server surface returns: a signed-in Kody page that
 * names the server, the authorization server, and the client mode before
 * Continue sends the person to the provider.
 */
export function buildMcpServerAuthorizeUrl(input: {
	appOrigin: string
	orgSlug: string
	serverId: string
}) {
	return new URL(
		orgSectionRestPath(
			input.orgSlug,
			'mcp-servers',
			`${input.serverId}/authorize`,
		),
		input.appOrigin,
	).toString()
}

type ConsentTokenBinding = {
	personId: string
	orgId: string
	serverId: string
	/** A new authorization attempt mints a new URL, which retires old tokens. */
	authorizationUrl: string
}

async function consentSigningKey(secret: string) {
	if (!secret.trim()) {
		throw new Error('Missing COOKIE_SECRET for MCP authorize consent tokens.')
	}
	return await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	)
}

function consentMessage(binding: ConsentTokenBinding) {
	return new TextEncoder().encode(
		JSON.stringify([
			consentTokenPurpose,
			binding.personId,
			binding.orgId,
			binding.serverId,
			binding.authorizationUrl,
		]),
	)
}

/**
 * CSRF token for the consent form. It is bound to the signed-in person, the
 * organization, the server, and the pending authorization, so a token from
 * another session, org, or attempt does not verify.
 */
export async function createMcpServerAuthorizeConsentToken(input: {
	secret: string
	binding: ConsentTokenBinding
}) {
	const signature = await crypto.subtle.sign(
		'HMAC',
		await consentSigningKey(input.secret),
		consentMessage(input.binding),
	)
	return bytesToBase64Url(new Uint8Array(signature))
}

export async function verifyMcpServerAuthorizeConsentToken(input: {
	secret: string
	token: string
	binding: ConsentTokenBinding
}) {
	let signature: Uint8Array<ArrayBuffer>
	try {
		signature = new Uint8Array(base64UrlToBytes(input.token))
	} catch {
		return false
	}
	return await crypto.subtle.verify(
		'HMAC',
		await consentSigningKey(input.secret),
		signature,
		consentMessage(input.binding),
	)
}
