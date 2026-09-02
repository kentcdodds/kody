import { expect, test } from 'vitest'
import { renderCommunityIconFallbackPng } from './community-icon.ts'
import {
	buildCommunityIconFallbackSvg,
	type communityIconFallbackPalettes,
	pickCommunityIconFallbackPalette,
} from './community-icon-fallback.ts'

const sampleNames = [
	'@kentcdodds/friction-log',
	'@kentcdodds/github-tools',
	'@kody/notion-mcp',
	'@kody/github-triage',
	'@jane/inbox-digest',
	'plain-slug',
] as const

function hexColorsIn(svg: string) {
	return [...svg.matchAll(/#(?:[0-9a-f]{6})/gi)].map((match) =>
		match[0].toLowerCase(),
	)
}

function paletteHexes(palette: (typeof communityIconFallbackPalettes)[number]) {
	return new Set(
		[palette.wash, palette.ribbon, palette.accent, palette.ink].map((hex) =>
			hex.toLowerCase(),
		),
	)
}

test('package-name fallbacks are deterministic swirls from a curated palette', async () => {
	const friction = buildCommunityIconFallbackSvg('@kentcdodds/friction-log')
	expect(friction).toBe(
		buildCommunityIconFallbackSvg('@kentcdodds/friction-log'),
	)
	expect(friction).not.toBe(
		buildCommunityIconFallbackSvg('@kentcdodds/github-tools'),
	)
	expect(friction).toContain('data-fallback-art="1"')
	expect(friction).toMatch(
		/data-palette="(dusk|sea|lichen|apricot|fog|lilac|inkwell|sand)"/,
	)
	expect(friction).toContain('<linearGradient')
	expect(friction).toContain('<clipPath')
	expect(friction.match(/<ellipse /g)?.length).toBe(2)
	expect(friction.match(/<path /g)?.length).toBe(3)

	for (const name of sampleNames) {
		const svg = buildCommunityIconFallbackSvg(name)
		const palette = pickCommunityIconFallbackPalette(name)
		const allowed = paletteHexes(palette)
		expect(svg).toContain(`data-palette="${palette.id}"`)
		expect(new Set(hexColorsIn(svg))).toEqual(allowed)
	}

	const palettesUsed = new Set(
		sampleNames.map((name) => pickCommunityIconFallbackPalette(name).id),
	)
	expect(palettesUsed.size).toBeGreaterThan(1)

	const frictionPng = await renderCommunityIconFallbackPng(
		'@kentcdodds/friction-log',
	)
	const toolsPng = await renderCommunityIconFallbackPng(
		'@kentcdodds/github-tools',
	)
	expect(Array.from(frictionPng.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
	expect(Array.from(toolsPng.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
	expect(frictionPng.byteLength).toBeGreaterThan(2_000)
	expect(toolsPng.byteLength).toBeGreaterThan(2_000)
	expect(frictionPng).not.toEqual(toolsPng)
})
