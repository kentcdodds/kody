import { fetchWithOptionalInsecureTls } from '../../http/fetch-with-insecure-tls.ts'

type IslandRouterApiFetch = typeof fetch

type FetchIslandRouterApiInput = {
	url: string
	init?: RequestInit
	timeoutMs: number
	allowInsecureTls: boolean
	fetchImpl?: IslandRouterApiFetch
}

export async function fetchIslandRouterApi(input: FetchIslandRouterApiInput) {
	return await fetchWithOptionalInsecureTls({
		...input,
		stringBodyErrorMessage:
			'Island Router API requests must use string bodies.',
	})
}
