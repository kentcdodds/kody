import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	getInlineStylesheet,
	resetInlineStylesheetCache,
} from '#app/inline-stylesheet.ts'

const productionStylesheetPath = path.join(
	import.meta.dirname,
	'../../public/styles.css',
)

test('production styles.css is escape-safe so homepage SSR can inline it', async () => {
	resetInlineStylesheetCache()
	const css = await readFile(productionStylesheetPath, 'utf8')
	const assets = {
		fetch: async () => new Response(css),
	}
	const inlined = await getInlineStylesheet({
		assets,
		buildId: 'inline-stylesheet-production-css',
	})
	expect(inlined).not.toBeNull()
	expect(inlined!.length).toBeGreaterThan(0)
	expect(inlined).not.toMatch(/[<>&]/)
})
