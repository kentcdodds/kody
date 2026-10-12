/**
 * The fetch gateway's half of a `credential()` client fetch (ADR 0068). Code
 * sends the client's handle in an out-of-band header; the gateway strips it,
 * places the credential through the door (which checks Use, hosts, and HTTPS
 * on every request), and sends the request with redirects held back, so the
 * client re-authorizes every hop by sending it through here again.
 */
import { applyCredentialClient } from '#worker/credentials/credential-client.ts'
import { type FetchGatewayProps } from './fetch-gateway.ts'

/** Response header naming the inject shape (never a value) on a 401 / 403. */
export const credentialClientHintHeaderName = 'x-kody-credential-hint'

export async function placeCredentialClient(input: {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	props: FetchGatewayProps
	token: string
	request: Request
}) {
	const applied = await applyCredentialClient({
		env: input.env as Env,
		request: input.props.request,
		baseUrl: input.props.baseUrl,
		binding: input.props.credentialClientBinding,
		token: input.token,
		requestUrl: new URL(input.request.url),
	})
	const headers = new Headers(input.request.headers)
	if (applied.header) headers.set(applied.header.name, applied.header.value)
	const body = input.request.body
	return {
		request: new Request(applied.url, {
			method: input.request.method,
			headers,
			body,
			redirect: 'manual',
			signal: input.request.signal,
			...(body ? { duplex: 'half' as const } : {}),
		}),
		substitutedValues: applied.substitutedValues,
		shape: applied.shape,
	}
}

export function withCredentialClientHint(response: Response, shape: string) {
	if (response.status !== 401 && response.status !== 403) return response
	const headers = new Headers(response.headers)
	headers.set(credentialClientHintHeaderName, shape)
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}
