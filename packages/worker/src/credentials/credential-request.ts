/**
 * Shared rules for the request-placing credential kinds (ADR 0068): which
 * hosts a credential's `hosts` allow, and the structured refusals their
 * resolvers throw. A refusal never carries a credential value.
 */
import { normalizeHost } from '#mcp/secrets/allowed-hosts.ts'

export type CredentialRequestRefusal =
	/** The request host is not in the credential's `hosts`. */
	| 'host_not_allowed'
	/** The request is not HTTPS. */
	| 'insecure_transport'
	/** The request does not have the shape the credential's kind takes. */
	| 'invalid_request'

export class CredentialRequestRefusedError extends Error {
	readonly code: CredentialRequestRefusal
	constructor(code: CredentialRequestRefusal, message: string) {
		super(message)
		this.name = 'CredentialRequestRefusedError'
		this.code = code
	}
}

/**
 * The picked credential does not exist, is another kind, or the actor cannot
 * use it. One error for all three, so it does not reveal which.
 */
export class CredentialNotFoundError extends Error {
	readonly code = 'credential_not_found'
	constructor() {
		super('No credential with that id that you can use for this request.')
		this.name = 'CredentialNotFoundError'
	}
}

/**
 * Whether `hosts` allow `host`: an exact host, or a `*.example.com` entry,
 * which matches exactly one more label (`api.example.com`, not
 * `example.com` or `a.b.example.com`). No hosts allow nothing.
 */
export function credentialHostsAllow(
	hosts: ReadonlyArray<string>,
	host: string,
) {
	const target = normalizeHost(host)
	if (!target) return false
	return hosts.some((entry) => {
		const normalized = entry.trim().toLowerCase()
		if (!normalized.startsWith('*.'))
			return normalizeHost(normalized) === target
		const suffix = normalized.slice(1)
		if (!target.endsWith(suffix)) return false
		const label = target.slice(0, -suffix.length)
		return label.length > 0 && !label.includes('.')
	})
}

export function assertHttpsUrl(url: URL) {
	if (url.protocol !== 'https:') {
		throw new CredentialRequestRefusedError(
			'insecure_transport',
			'Credentials are only sent over HTTPS.',
		)
	}
}
