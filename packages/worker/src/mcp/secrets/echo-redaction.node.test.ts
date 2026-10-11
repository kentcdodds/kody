import { expect, test } from 'vitest'
import {
	createEchoRedactionStream,
	redactEchoedSecrets,
} from './echo-redaction.ts'

const encoder = new TextEncoder()

async function redactChunks(chunks: Array<Uint8Array>, values: Array<string>) {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk)
			controller.close()
		},
	}).pipeThrough(createEchoRedactionStream(values))
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

test('redacts a value however the body is chunked, including split mid-value', async () => {
	const body = 'before sk_live_abc123 middle sk_live_abc123 after'
	const bytes = encoder.encode(body)
	const expected = 'before [REDACTED SECRET] middle [REDACTED SECRET] after'
	for (let split = 0; split <= bytes.length; split += 1) {
		const output = await redactChunks(
			[bytes.subarray(0, split), bytes.subarray(split)],
			['sk_live_abc123'],
		)
		expect(text(output)).toBe(expected)
	}
	const oneByteChunks = Array.from(bytes, (byte) => new Uint8Array([byte]))
	expect(text(await redactChunks(oneByteChunks, ['sk_live_abc123']))).toBe(
		expected,
	)
})

test('prefers the longest value at a position and leaves other bytes intact', async () => {
	expect(
		text(
			await redactChunks(
				[encoder.encode('token=abcdef; short=abc; ünïcode-secret')],
				['abc', 'abcdef', 'ünïcode-secret'],
			),
		),
	).toBe('token=[REDACTED SECRET]; short=[REDACTED SECRET]; [REDACTED SECRET]')
	const binary = new Uint8Array([0xff, 0x00, 0x89, 0x50, 0xfe])
	expect(await redactChunks([binary], ['secret'])).toEqual(binary)
})

test('redactEchoedSecrets redacts headers, set-cookie, and status text and keeps url', async () => {
	const upstream = new Response('echo: Bearer tok-123', {
		status: 401,
		statusText: 'bad tok-123',
		headers: {
			'content-length': '20',
			'www-authenticate': 'Bearer realm="tok-123"',
			location: 'https://evil.test/?t=tok-123',
		},
	})
	upstream.headers.append('set-cookie', 'a=tok-123; Path=/')
	upstream.headers.append('set-cookie', 'b=plain; Path=/')
	Object.defineProperty(upstream, 'url', { value: 'https://api.test/me' })

	const redacted = redactEchoedSecrets(upstream, ['tok-123', ''])
	expect(redacted.status).toBe(401)
	expect(redacted.statusText).toBe('bad [REDACTED SECRET]')
	expect(redacted.url).toBe('https://api.test/me')
	expect(redacted.headers.get('content-length')).toBeNull()
	expect(redacted.headers.get('www-authenticate')).toBe(
		'Bearer realm="[REDACTED SECRET]"',
	)
	expect(redacted.headers.get('location')).toBe(
		'https://evil.test/?t=[REDACTED SECRET]',
	)
	expect(redacted.headers.getSetCookie()).toEqual([
		'a=[REDACTED SECRET]; Path=/',
		'b=plain; Path=/',
	])
	expect(await redacted.text()).toBe('echo: Bearer [REDACTED SECRET]')

	const untouched = new Response('ok')
	expect(redactEchoedSecrets(untouched, [])).toBe(untouched)
	const empty = redactEchoedSecrets(new Response(null, { status: 204 }), [
		'tok-123',
	])
	expect(empty.status).toBe(204)
	expect(empty.body).toBeNull()
})
