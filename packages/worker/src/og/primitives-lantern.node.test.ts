import { expect, test } from 'vitest'
import { landingHomePrimitives } from '#universal/landing-home-copy.ts'
import { ensureOgBinaryAssetsReady } from '#worker/og/og-image-assets.ts'
import { type SatoriChild, type SatoriElement } from '#worker/og/render.ts'
import { createPrimitivesLantern } from './primitives-lantern.ts'

function collectText(
	node: SatoriChild | Array<SatoriChild> | undefined,
): Array<string> {
	if (node == null) return []
	if (typeof node === 'string') return [node]
	if (Array.isArray(node)) return node.flatMap((child) => collectText(child))
	return collectText(node.props.children)
}

function countPaths(
	node: SatoriChild | Array<SatoriChild> | undefined,
): number {
	if (node == null || typeof node === 'string') return 0
	if (Array.isArray(node)) {
		return node.reduce((sum, child) => sum + countPaths(child), 0)
	}
	const self = node.type === 'path' ? 1 : 0
	return self + countPaths(node.props.children)
}

test('homepage OG lantern lists every primitive and draws a leader each', async () => {
	await ensureOgBinaryAssetsReady()
	const markup: SatoriElement = createPrimitivesLantern('dark')
	expect(collectText(markup)).toEqual(
		landingHomePrimitives.map((primitive) => primitive.word),
	)
	// Halo plus core stroke for each primitive.
	expect(countPaths(markup)).toBe(landingHomePrimitives.length * 2)
})
