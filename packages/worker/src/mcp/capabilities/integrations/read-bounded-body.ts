export class BoundedBodyTooLargeError extends Error {
	constructor(maxBytes: number) {
		super(`response exceeds ${maxBytes} bytes`)
		this.name = 'BoundedBodyTooLargeError'
	}
}

function parseContentLength(response: Response): number | null {
	const header = response.headers.get('Content-Length')
	if (header == null) {
		return null
	}
	const length = Number(header)
	if (!Number.isFinite(length) || length < 0) {
		return null
	}
	return length
}

export async function readBoundedBody(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const contentLength = parseContentLength(response)
	if (contentLength != null && contentLength > maxBytes) {
		throw new BoundedBodyTooLargeError(maxBytes)
	}

	if (response.body == null) {
		const body = await response.text()
		if (new TextEncoder().encode(body).byteLength > maxBytes) {
			throw new BoundedBodyTooLargeError(maxBytes)
		}
		return body
	}

	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let body = ''
	let totalBytes = 0

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}
			if (value.byteLength === 0) {
				continue
			}

			totalBytes += value.byteLength
			if (totalBytes > maxBytes) {
				void reader.cancel().catch(() => {})
				throw new BoundedBodyTooLargeError(maxBytes)
			}

			body += decoder.decode(value, { stream: true })
		}

		body += decoder.decode()
		return body
	} catch (error) {
		if (error instanceof BoundedBodyTooLargeError) {
			throw error
		}
		void reader.cancel().catch(() => {})
		throw error
	}
}
