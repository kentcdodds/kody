import { expect, test } from 'vitest'
import { EncodedPlaceholderError } from './encoded-placeholder.ts'
import { createPlaceholderFillStream } from './placeholder-stream-fill.ts'

function encode(text: string) {
	return new TextEncoder().encode(text)
}

function decode(bytes: Uint8Array) {
	return new TextDecoder().decode(bytes)
}

async function readAll(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader()
	const chunks: Array<Uint8Array> = []
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
	}
	let length = 0
	for (const chunk of chunks) length += chunk.byteLength
	const bytes = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes
}

function chunkedStream(parts: ReadonlyArray<string>) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const part of parts) controller.enqueue(encode(part))
			controller.close()
		},
	})
}

test('stream fill joins a placeholder split across chunks', async () => {
	const replacements = new Map([['{{secret:token}}', 's3cret']])
	const fill = createPlaceholderFillStream({
		source: chunkedStream(['hello {{sec', 'ret:token}} world']),
		format: 'text',
		replacements,
		resolve: async () => [],
	})
	const body = decode(await readAll(fill.stream))
	await fill.done
	expect(body).toBe('hello s3cret world')
	expect(fill.substitutedValues).toContain('s3cret')
})

test('stream fill holds a later literal opener after an earlier percent fragment', async () => {
	const replacements = new Map([['{{secret:token}}', 'ok']])
	const fill = createPlaceholderFillStream({
		source: chunkedStream(['price=100% {{sec', 'ret:token}}']),
		format: 'text',
		replacements,
		resolve: async () => [],
	})
	expect(decode(await readAll(fill.stream))).toBe('price=100% ok')
	await fill.done
})

test('stream fill fills a multipart text part', async () => {
	const boundary = '----Bound'
	const replacements = new Map([['{{secret:token}}', 'filled-token']])
	const part = [
		`--${boundary}`,
		'Content-Disposition: form-data; name="payload"',
		'',
		'Bearer {{secret:token}}',
		`--${boundary}--`,
		'',
	].join('\r\n')
	const fill = createPlaceholderFillStream({
		source: chunkedStream([part.slice(0, 40), part.slice(40)]),
		format: 'multipart',
		replacements,
		resolve: async () => [],
	})
	expect(decode(await readAll(fill.stream))).toContain('Bearer filled-token')
	await fill.done
})

test('stream fill JSON-escapes values', async () => {
	const replacements = new Map([['{{secret:token}}', 'say "hi"']])
	const fill = createPlaceholderFillStream({
		source: chunkedStream(['{"a":"{{secret:token}}"}']),
		format: 'json',
		replacements,
		resolve: async () => [],
	})
	expect(decode(await readAll(fill.stream))).toBe('{"a":"say \\"hi\\""}')
	await fill.done
})

test('stream fill refuses percent-encoded placeholders outside form bodies', async () => {
	const fill = createPlaceholderFillStream({
		source: chunkedStream(['%7B%7Bsecret%3Atoken%7D%7D']),
		format: 'text',
		replacements: new Map(),
		resolve: async () => [],
	})
	await expect(readAll(fill.stream)).rejects.toBeInstanceOf(
		EncodedPlaceholderError,
	)
})

test('stream fill accepts percent-encoded placeholders in form bodies', async () => {
	const replacements = new Map([['{{secret:token}}', 'a b']])
	const fill = createPlaceholderFillStream({
		source: chunkedStream(['q=%7B%7Bsecret%3Atoken%7D%7D']),
		format: 'form',
		replacements,
		allowPercentEncoded: true,
		resolve: async () => [],
	})
	expect(decode(await readAll(fill.stream))).toBe('q=a+b')
	await fill.done
})

test('stream fill joins a percent-encoded form placeholder split across chunks', async () => {
	const replacements = new Map([['{{secret:token}}', 'ok']])
	const fill = createPlaceholderFillStream({
		source: chunkedStream(['q=%7B%7Bsec', 'ret%3Atoken%7D%7D']),
		format: 'form',
		replacements,
		allowPercentEncoded: true,
		resolve: async () => [],
	})
	expect(decode(await readAll(fill.stream))).toBe('q=ok')
	await fill.done
})

test('stream fill refuses percent-encoded placeholders split across text chunks', async () => {
	const fill = createPlaceholderFillStream({
		source: chunkedStream(['%7B%7Bsec', 'ret%3Atoken%7D%7D']),
		format: 'text',
		replacements: new Map(),
		resolve: async () => [],
	})
	await expect(readAll(fill.stream)).rejects.toBeInstanceOf(
		EncodedPlaceholderError,
	)
})

test('stream fill refuses base64 placeholders in form bodies', async () => {
	const opener = btoa('{{secret:')
	const fill = createPlaceholderFillStream({
		source: chunkedStream([`q=${opener}`]),
		format: 'form',
		replacements: new Map(),
		allowPercentEncoded: true,
		resolve: async () => [],
	})
	await expect(readAll(fill.stream)).rejects.toBeInstanceOf(
		EncodedPlaceholderError,
	)
})

test('stream fill UTF-8 encodes non-ASCII secrets', async () => {
	const replacements = new Map([['{{secret:token}}', 'café']])
	const fill = createPlaceholderFillStream({
		source: chunkedStream(['x={{secret:token}}']),
		format: 'text',
		replacements,
		resolve: async () => [],
	})
	const bytes = await readAll(fill.stream)
	await fill.done
	expect(decode(bytes)).toBe('x=café')
	expect([...bytes]).toEqual([...encode('x=café')])
})

test('stream fill settles done when the consumer cancels', async () => {
	const fill = createPlaceholderFillStream({
		source: chunkedStream(['{{secret:token}}', ' and more']),
		format: 'text',
		replacements: new Map([['{{secret:token}}', 'x']]),
		resolve: async () => [],
	})
	const reader = fill.stream.getReader()
	await reader.read()
	await reader.cancel()
	await expect(fill.done).resolves.toBeUndefined()
})

test('stream fill leaves nested placeholders in values literal (single pass)', async () => {
	const replacements = new Map([
		['{{secret:token}}', '{{secret:apiKey}}'],
		['{{secret:apiKey}}', 'api-key-value'],
	])
	const fill = createPlaceholderFillStream({
		source: chunkedStream(['Bearer {{secret:token}}']),
		format: 'text',
		replacements,
		resolve: async () => [],
	})
	expect(decode(await readAll(fill.stream))).toBe('Bearer {{secret:apiKey}}')
	await fill.done
})

test('stream fill fills a later top-level placeholder without expanding nested text from a prior value', async () => {
	const replacements = new Map([
		['{{secret:token}}', '{{secret:apiKey}}'],
		['{{secret:apiKey}}', 'api-key-value'],
	])
	const fill = createPlaceholderFillStream({
		source: chunkedStream(['{{secret:token}}', ' and {{secret:apiKey}}']),
		format: 'text',
		replacements,
		resolve: async () => [],
	})
	expect(decode(await readAll(fill.stream))).toBe(
		'{{secret:apiKey}} and api-key-value',
	)
	await fill.done
})

test('stream fill does not fill a placeholder formed by a secret value plus the next chunk', async () => {
	const replacements = new Map([
		['{{secret:token}}', 'prefix-{{secret:api'],
		['{{secret:apiKey}}', 'api-key-value'],
	])
	const fill = createPlaceholderFillStream({
		source: chunkedStream(['{{secret:token}}', 'Key}} suffix']),
		format: 'text',
		replacements,
		resolve: async () => [],
	})
	expect(decode(await readAll(fill.stream))).toBe(
		'prefix-{{secret:apiKey}} suffix',
	)
	await fill.done
})

test('stream fill does not fill when a value opener prefix recombines with the next chunk', async () => {
	const replacements = new Map([
		['{{secret:token}}', '{{secre'],
		['{{secret:apiKey}}', 'api-key-value'],
	])
	const fill = createPlaceholderFillStream({
		source: chunkedStream(['A={{secret:token}}', 't:apiKey}}']),
		format: 'text',
		replacements,
		resolve: async () => [],
	})
	expect(decode(await readAll(fill.stream))).toBe('A={{secret:apiKey}}')
	await fill.done
})

test('stream fill JSON path keeps nested placeholders in values literal across chunks', async () => {
	const replacements = new Map([
		['{{secret:token}}', 'say "{{secret:apiKey}}"'],
		['{{secret:apiKey}}', 'api-key-value'],
	])
	const fill = createPlaceholderFillStream({
		source: chunkedStream(['{"a":"', '{{secret:token}}', '"}']),
		format: 'json',
		replacements,
		resolve: async () => [],
	})
	expect(decode(await readAll(fill.stream))).toBe(
		'{"a":"say \\"{{secret:apiKey}}\\""}',
	)
	await fill.done
})

test('stream fill multipart keeps nested placeholders in part values literal', async () => {
	const boundary = '----bound'
	const replacements = new Map([
		['{{secret:token}}', 'prefix-{{secret:api'],
		['{{secret:apiKey}}', 'api-key-value'],
	])
	const part = [
		`--${boundary}`,
		'Content-Disposition: form-data; name="payload"',
		'',
		'Bearer {{secret:token}}',
		`--${boundary}--`,
		'',
	].join('\r\n')
	// Split so the filled value's unclosed opener would recombine with the
	// remainder of the part if carry re-scanned substituted bytes.
	const splitAt = part.indexOf('{{secret:token}}') + '{{secret:token}}'.length
	const fill = createPlaceholderFillStream({
		source: chunkedStream([
			part.slice(0, splitAt),
			'Key}}' + part.slice(splitAt),
		]),
		format: 'multipart',
		replacements,
		resolve: async () => [],
	})
	const body = decode(await readAll(fill.stream))
	expect(body).toContain('Bearer prefix-{{secret:apiKey}}')
	expect(body).not.toContain('api-key-value')
	await fill.done
})
