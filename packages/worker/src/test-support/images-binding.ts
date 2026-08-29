export const tinyPngBytes = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	),
	(character) => character.charCodeAt(0),
)

export const tinyWebpBytes = Uint8Array.from(
	atob('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'),
	(character) => character.charCodeAt(0),
)

export type FakeImagesCall = {
	inputBytes: Uint8Array
	transform: ImageTransform | null
	output: ImageOutputOptions
}

export type FakeImagesBinding = ImagesBinding & {
	calls: Array<FakeImagesCall>
}

/**
 * Node-unit stand-in for `env.IMAGES`. It does not decode pixels; it records
 * the requested transform and returns a tiny fixture in the asked format so
 * ingest tests can run without the Workers Images simulator.
 */
export function createFakeImagesBinding(): FakeImagesBinding {
	const calls: Array<FakeImagesCall> = []
	return {
		calls,
		async info() {
			throw new Error('Fake ImagesBinding.info is not implemented.')
		},
		input(stream: ReadableStream<Uint8Array>) {
			let transform: ImageTransform | null = null
			const transformer = {
				transform(next: ImageTransform) {
					transform = next
					return transformer
				},
				draw() {
					return transformer
				},
				async output(output: ImageOutputOptions) {
					const inputBytes = new Uint8Array(
						await new Response(stream).arrayBuffer(),
					)
					calls.push({ inputBytes, transform, output })
					const bytes =
						output.format === 'image/png' ? tinyPngBytes : tinyWebpBytes
					return {
						response: () =>
							new Response(bytes, {
								headers: { 'content-type': output.format },
							}),
						contentType: () => output.format,
						image: () => new Blob([bytes]).stream(),
					}
				},
			}
			return transformer
		},
		hosted: {} as HostedImagesBinding,
	} as FakeImagesBinding
}
