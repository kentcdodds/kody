/**
 * Palettes for Satori-rendered Open Graph images.
 *
 * Satori cannot read CSS custom properties, so these values mirror the design
 * tokens in `packages/worker/public/styles.css`. Keep the two in sync when the
 * app palette changes. Cards default to dark so Kody's lantern can light the
 * brand's signature graphite canvas; `?theme=light` on an OG route renders the
 * pale variant instead.
 *
 * `textReading` is the one deliberate departure from the app tokens: a share
 * card is usually read at a third of its rendered size in a feed, where
 * `textMuted` turns to grey mush. It sits between `textMuted` and `text` —
 * 11.1:1 on the dark ground versus 7.4:1, and 8.6:1 on the pale one versus
 * 6.3:1 — and is only for body copy on a card.
 */
export const ogPalettes = {
	light: {
		primary: '#008819',
		primaryHover: '#007406',
		onPrimary: '#ffffff',
		primaryText: '#006d00',
		background: '#e6e8ea',
		surface: '#f6f7f8',
		text: '#171b20',
		textMuted: '#4e535a',
		textReading: '#3a3f46',
		border: '#c7cbd0',
	},
	dark: {
		primary: '#33c447',
		primaryHover: '#48d858',
		onPrimary: '#031c08',
		primaryText: '#45cd55',
		background: '#111417',
		surface: '#1b1e23',
		text: '#eaedf0',
		textMuted: '#a0a5ab',
		textReading: '#c5c9ce',
		border: '#32363b',
	},
} as const

export type OgTheme = keyof typeof ogPalettes
export type OgPalette = (typeof ogPalettes)[OgTheme]

/** Dark is the default look; `?theme=light` on an OG route asks for the other. */
export const OG_DEFAULT_THEME: OgTheme = 'dark'

export function parseOgTheme(value: string | null): OgTheme {
	return value === 'light' || value === 'dark' ? value : OG_DEFAULT_THEME
}

export function getOgPalette(theme: OgTheme = OG_DEFAULT_THEME) {
	return ogPalettes[theme]
}

export const ogPalette = ogPalettes[OG_DEFAULT_THEME]
