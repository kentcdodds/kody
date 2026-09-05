const doctypeBytes = new TextEncoder().encode('<!DOCTYPE html>')

/**
 * Waits for the renderer's first chunk before handing back a body stream.
 *
 * `renderToStream` resolves the whole document before it enqueues anything, so
 * a component that throws during render errors the stream before its first
 * chunk. Reading that chunk here turns such a failure into a rejection the
 * caller can answer with a real error response, instead of a committed `200`
 * whose body stops after the doctype (which the browser shows as a blank page
 * and shared caches can store). The remix/ui renderer also emits markup
 * starting at `<html>`; without a doctype the browser parses the document in
 * quirks mode, so the doctype is prepended once the document is known to exist.
 */
export async function openDocumentStream(
	stream: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
	const reader = stream.getReader()
	const first = await reader.read()
	if (first.done) {
		throw new Error('SSR render produced no document')
	}
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(doctypeBytes)
			controller.enqueue(first.value)
		},
		async pull(controller) {
			const next = await reader.read()
			if (next.done) {
				controller.close()
				return
			}
			controller.enqueue(next.value)
		},
		cancel(reason) {
			// Client disconnects cancel the body; release the renderer too.
			return reader.cancel(reason)
		},
	})
}
