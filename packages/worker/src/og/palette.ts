/**
 * Light-mode palette for Satori-rendered Open Graph images.
 *
 * Satori cannot read CSS custom properties, so these values mirror the
 * light-mode design tokens in `packages/worker/public/styles.css` (`:root`).
 * Keep the two in sync when the app palette changes.
 */
export const ogPalette = {
	/** --color-background */
	background: '#f8fafc',
	/** --color-surface */
	surface: '#f1f5f9',
	/** --color-text */
	text: '#0f172a',
	/** --color-text-muted */
	muted: '#475569',
	/** --color-border */
	border: '#cbd5e1',
	/** --color-primary */
	primary: '#2563eb',
	/** --color-primary-text (used for the wordmark, matching the home hero) */
	primaryText: '#1e40af',
	/** --color-on-primary */
	onPrimary: '#ffffff',
} as const

/**
 * Card corner radius in canvas pixels. The app's `--radius-xl` is 16px;
 * OG images render at 1200×630 (roughly 1.5× typical UI scale), so 24px
 * keeps the same visual proportion.
 */
export const OG_CARD_RADIUS = 24
