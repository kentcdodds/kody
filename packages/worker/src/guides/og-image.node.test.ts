import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { expect, test } from 'vitest'
import { renderGuideOgImage } from './og-image.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

test('guide OG renderer composes title, description, and JPEG artwork', async () => {
	const artwork = readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			'../../public/images/kody-factory-map-og.jpg',
		),
	)
	const png = await renderGuideOgImage({
		title: 'The Kody factory map',
		description:
			"Map Kody's discovery, credentials, integrations, packages, storage, schedules, hosted surfaces, and memories.",
		imageDataUri: `data:image/jpeg;base64,${bytesToBase64(artwork)}`,
	})

	expect(png.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(png[index]).toBe(byte)
	}
})
