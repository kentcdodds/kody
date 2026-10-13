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
	const commentStripped = css.replace(/\/\*[\s\S]*?\*\//g, '').trim()
	expect(inlined!.length).toBeLessThan(commentStripped.length)
	expect(inlined).toContain('@font-face')
	expect(inlined).toContain('.landing-hero')
})

test('inline stylesheet minify keeps url() and quoted strings intact', async () => {
	resetInlineStylesheetCache()
	const css = `
		/* keep me out */
		.foo {
			background: url("/images/a b.svg");
			content: "hello  world";
			margin: 0   auto;
		}
	`
	const inlined = await getInlineStylesheet({
		assets: { fetch: async () => new Response(css) },
		buildId: 'inline-stylesheet-minify',
	})
	expect(inlined).toBe(
		'.foo{background:url("/images/a b.svg");content:"hello  world";margin:0 auto;}',
	)
})

test('inline stylesheet minify keeps media and (), descendant :, and calc spaces', async () => {
	resetInlineStylesheetCache()
	const css = `
		@media (hover: hover) and (pointer: fine) {
			.pill:hover { opacity: 0.9; }
		}
		[data-focus-container] :focus-visible { outline: none; }
		.hero { transform: translateY(calc(100% + (1rem - 2px))); }
	`
	const inlined = await getInlineStylesheet({
		assets: { fetch: async () => new Response(css) },
		buildId: 'inline-stylesheet-minify-tokens',
	})
	expect(inlined).toContain('@media (hover:hover) and (pointer:fine)')
	expect(inlined).toContain('[data-focus-container] :focus-visible')
	expect(inlined).toContain('calc(100% + (1rem - 2px))')
	expect(inlined).not.toMatch(/\band\(/)
	expect(inlined).not.toContain('[data-focus-container]:focus-visible')
})
