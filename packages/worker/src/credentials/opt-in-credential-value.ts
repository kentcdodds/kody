/**
 * Whether a value fits an opt-in credential kind (ADR 0068). A leaf module so
 * every secret write path, including the secrets service, can check it.
 */
import { McpCallerError } from '#mcp/caller-error.ts'
import { credentialHostsAllow } from './credential-request.ts'

export const optInStoredCredentialKinds = ['url', 'login', 'signing'] as const

export type OptInStoredCredentialKind =
	(typeof optInStoredCredentialKinds)[number]

/**
 * Checks the value against the kind before it is stored, so a misconfigured
 * credential fails at write time instead of at first use. Messages never
 * repeat the value.
 */
export function assertOptInCredentialValue(input: {
	kind: OptInStoredCredentialKind
	value: string
	hosts: ReadonlyArray<string>
}) {
	switch (input.kind) {
		case 'url': {
			let url: URL
			try {
				url = new URL(input.value.trim())
			} catch {
				throw new McpCallerError('A url credential value is a whole URL.')
			}
			if (url.protocol !== 'https:') {
				throw new McpCallerError('A url credential value must use https://.')
			}
			if (url.username || url.password) {
				throw new McpCallerError(
					'A url credential cannot carry a username or password in its URL.',
				)
			}
			if (!credentialHostsAllow(input.hosts, url.hostname)) {
				throw new McpCallerError(
					"A url credential value's host must be one of its hosts.",
				)
			}
			return
		}
		case 'login': {
			let parsed: unknown
			try {
				parsed = JSON.parse(input.value)
			} catch {
				parsed = null
			}
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new McpCallerError(
					'A login credential value is a JSON object of its login fields, for example {"username":"…","password":"…"}.',
				)
			}
			return
		}
		case 'signing':
			return
		default: {
			const exhaustive: never = input.kind
			throw new Error(`Unhandled credential kind: ${String(exhaustive)}`)
		}
	}
}
