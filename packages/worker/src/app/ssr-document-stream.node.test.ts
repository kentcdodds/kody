import { expect, test } from 'vitest'
import { openDocumentStream } from '#app/ssr-document-stream.ts'

const encoder = new TextEncoder()

/**
 * Emits one chunk per pull so a trailing error lands after the consumer has
 * read the earlier chunks, the way remix/ui's renderer fails asynchronously
 * after enqueueing the document.
 */
function streamOf(
	chunks: Array<string>,
	options: { errorAfter?: Error; errorBeforeFirst?: Error } = {},
) {
	let index = 0
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index === 0 && options.errorBeforeFirst) {
				controller.error(options.errorBeforeFirst)
				return
			}
			if (index < chunks.length) {
				controller.enqueue(encoder.encode(chunks[index]!))
				index += 1
				return
			}
			if (options.errorAfter) controller.error(options.errorAfter)
			else controller.close()
		},
	})
}

test('prepends the doctype to a rendered document', async () => {
	const body = await openDocumentStream(
		streamOf(['<html><body>hi</body></html>', '<!-- tail -->']),
	)
	await expect(new Response(body).text()).resolves.toBe(
		'<!DOCTYPE html><html><body>hi</body></html><!-- tail -->',
	)
})

test('rejects instead of committing a body when the render fails before its first chunk', async () => {
	// remix/ui's renderToStream resolves the whole document before enqueueing
	// anything, so a component throwing during SSR (a missing router context
	// after an HMR re-evaluation, a failing loader) errors the stream here.
	const failure = new Error('Cannot read properties of undefined')
	await expect(
		openDocumentStream(streamOf([], { errorBeforeFirst: failure })),
	).rejects.toBe(failure)
})

test('rejects when the renderer closes without producing a document', async () => {
	await expect(openDocumentStream(streamOf([]))).rejects.toThrow(
		'SSR render produced no document',
	)
})

test('propagates a mid-stream failure as a stream error, not a clean close', async () => {
	const failure = new Error('frame failed')
	const body = await openDocumentStream(
		streamOf(['<html></html>'], { errorAfter: failure }),
	)
	await expect(new Response(body).text()).rejects.toBe(failure)
})

test('cancelling the body cancels the renderer', async () => {
	let cancelledWith: unknown = null
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode('<html>'))
		},
		cancel(reason) {
			cancelledWith = reason
		},
	})
	const body = await openDocumentStream(source)
	await body.cancel('client went away')
	expect(cancelledWith).toBe('client went away')
})
