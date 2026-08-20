/**
 * Responsive marketing art. Variants live next to the full-size originals
 * under `packages/worker/public/images/`. Intrinsic `width`/`height` stay
 * the display box (CSS shrinks them); `srcSet` picks bytes by viewport.
 */

export const heroBaseImage = {
	src: '/images/hero/kody-base-640.webp',
	srcSet: [
		'/images/hero/kody-base-640.webp 640w',
		'/images/hero/kody-base-960.webp 960w',
		'/images/hero/kody-base.webp 1254w',
	].join(', '),
	sizes: '(max-width: 640px) 90vw, 640px',
	width: 1254,
	height: 1254,
} as const

export const landingArtNames = [
	'kody-compounding-capabilities',
	'kody-community-packages',
	'kody-factory-map',
	'kody-keys',
	'kody-greeting',
] as const

export type LandingArtName = (typeof landingArtNames)[number]

const landingArtFullWidth: Record<LandingArtName, number> = {
	'kody-compounding-capabilities': 1000,
	'kody-community-packages': 627,
	'kody-factory-map': 1024,
	'kody-keys': 700,
	'kody-greeting': 700,
}

export function landingArtAttrs(name: LandingArtName) {
	const fullWidth = landingArtFullWidth[name]
	const candidates = [`/images/${name}-480.webp 480w`]
	if (fullWidth >= 960) {
		candidates.push(`/images/${name}-960.webp 960w`)
	}
	candidates.push(`/images/${name}.webp ${fullWidth}w`)
	return {
		src: `/images/${name}-480.webp`,
		srcSet: candidates.join(', '),
		sizes: '(max-width: 800px) 60vw, 400px',
		decoding: 'async' as const,
		loading: 'lazy' as const,
	}
}
