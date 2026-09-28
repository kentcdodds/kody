import { type LandingPrimitiveId } from '../../../worker/universal/landing-lantern.ts'

/**
 * Dark-mode tokens from `packages/worker/public/styles.css`. The video is
 * always dark, so it reads the `-dark` variants directly.
 */
export const colors = {
	canvas: 'oklch(0.155 0.01 255)',
	background: 'oklch(0.19 0.008 255)',
	surface: 'oklch(0.235 0.01 255)',
	surfaceRaised: 'oklch(0.27 0.012 255)',
	border: 'oklch(0.33 0.01 255)',
	fieldBorder: 'oklch(0.55 0.012 255)',
	text: 'oklch(0.945 0.005 250)',
	textMuted: 'oklch(0.72 0.01 255)',
	primary: 'oklch(0.72 0.205 145)',
	primaryText: 'oklch(0.75 0.2 145)',
	onPrimary: 'oklch(0.2 0.05 148)',
	danger: 'oklch(0.75 0.16 25)',
	warning: 'oklch(0.84 0.16 85)',
	lanternGlow: 'oklch(0.8 0.13 80 / 0.55)',
	lanternCore: 'oklch(0.86 0.14 82)',
} as const

export const primitiveColors = {
	memory: 'oklch(0.72 0.17 29)',
	secrets: 'oklch(0.72 0.19 300)',
	packages: 'oklch(0.72 0.17 255)',
	triggers: 'oklch(0.89 0.17 96)',
	integrations: 'oklch(0.76 0.19 148)',
	apps: 'oklch(0.8 0.18 345)',
} as const satisfies Record<LandingPrimitiveId, string>

export const fonts = {
	display: "'Bricolage Grotesque', system-ui, sans-serif",
	body: "'Wix Madefor Text', system-ui, sans-serif",
	mono: "ui-monospace, 'SF Mono', Menlo, monospace",
} as const
