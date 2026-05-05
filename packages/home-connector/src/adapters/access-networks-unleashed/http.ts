import { fetchWithOptionalInsecureTls } from '../../http/fetch-with-insecure-tls.ts'

type FetchAccessNetworksUnleashedInput = {
	url: string
	init?: RequestInit
	timeoutMs: number
	allowInsecureTls: boolean
}

export async function fetchAccessNetworksUnleashed(
	input: FetchAccessNetworksUnleashedInput,
) {
	return await fetchWithOptionalInsecureTls({
		...input,
		stringBodyErrorMessage:
			'Access Networks Unleashed requests must use string bodies.',
	})
}
