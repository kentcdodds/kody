/**
 * Split `items` into consecutive chunks of at most `size` elements.
 *
 * The main consumer is D1 query building: D1 caps a statement at 100 bound
 * parameters, so `IN (...)` lists over caller-controlled collections (for
 * example `pageSize=100` admin pages) must be chunked or the query fails with
 * `too many SQL variables`.
 */
export function chunkArray<T>(items: ReadonlyArray<T>, size: number) {
	if (size < 1) throw new Error(`Chunk size must be >= 1, got ${size}.`)
	const chunks: Array<Array<T>> = []
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size))
	}
	return chunks
}

/**
 * D1's documented per-statement bound parameter cap. Queries binding a
 * dynamic list must keep `list length + fixed bindings` at or below this.
 */
export const maxD1BoundParameters = 100
