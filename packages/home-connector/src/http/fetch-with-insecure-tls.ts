import { type IncomingMessage, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const nativeFetch = globalThis.fetch

type FetchWithOptionalInsecureTlsInput = {
	url: string
	init?: RequestInit
	timeoutMs: number
	allowInsecureTls: boolean
	fetchImpl?: typeof fetch
	stringBodyErrorMessage: string
}

function headersToRequestHeaders(headers: Headers) {
	const output: Record<string, string> = {}
	for (const [key, value] of headers.entries()) {
		output[key] = value
	}
	return output
}

function headersFromIncomingHeaders(
	headers: Record<string, string | Array<string> | undefined>,
) {
	const output = new Headers()
	for (const [key, value] of Object.entries(headers)) {
		if (Array.isArray(value)) {
			for (const entry of value) {
				output.append(key, entry)
			}
			continue
		}
		if (typeof value === 'string') {
			output.append(key, value)
		}
	}
	return output
}

async function fetchWithInsecureTls(input: {
	url: string
	init?: RequestInit
	signal: AbortSignal
	stringBodyErrorMessage: string
}) {
	const url = new URL(input.url)
	const headers = new Headers(input.init?.headers)
	const body = input.init?.body
	if (body != null && typeof body !== 'string' && !(body instanceof Buffer)) {
		throw new Error(input.stringBodyErrorMessage)
	}
	const requestOptions = {
		method: input.init?.method ?? 'GET',
		headers: headersToRequestHeaders(headers),
	}

	return await new Promise<Response>((resolve, reject) => {
		const handleResponse = (res: IncomingMessage) => {
			const chunks: Array<Buffer> = []
			res.on('data', (chunk: Buffer | string) => {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
			})
			res.on('error', reject)
			res.on('end', () => {
				resolve(
					new Response(Buffer.concat(chunks), {
						status: res.statusCode ?? 500,
						statusText: res.statusMessage,
						headers: headersFromIncomingHeaders(res.headers),
					}),
				)
			})
		}
		const req =
			url.protocol === 'http:'
				? httpRequest(url, requestOptions, handleResponse)
				: httpsRequest(
						url,
						{
							...requestOptions,
							rejectUnauthorized: false,
						},
						handleResponse,
					)
		req.on('error', reject)
		input.signal.addEventListener(
			'abort',
			() => {
				req.destroy(
					new DOMException('The operation was aborted.', 'AbortError'),
				)
			},
			{ once: true },
		)
		if (body != null) req.end(body)
		else req.end()
	})
}

export async function fetchWithOptionalInsecureTls(
	input: FetchWithOptionalInsecureTlsInput,
) {
	const fetchImpl = input.fetchImpl ?? globalThis.fetch
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
	try {
		if (
			input.allowInsecureTls &&
			fetchImpl === nativeFetch &&
			input.url.startsWith('https:')
		) {
			return await fetchWithInsecureTls({
				url: input.url,
				init: input.init,
				signal: controller.signal,
				stringBodyErrorMessage: input.stringBodyErrorMessage,
			})
		}
		return await fetchImpl(input.url, {
			...input.init,
			signal: controller.signal,
		})
	} finally {
		clearTimeout(timeout)
	}
}
