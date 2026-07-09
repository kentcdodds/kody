import { ogPalette } from '#worker/og/palette.ts'
import { type PublicOgPage } from '#worker/og/pages.ts'
import {
	createOgFrame,
	renderOgImage,
	truncateOgText,
	type SatoriElement,
} from '#worker/og/render.ts'

const TITLE_MAX_LENGTH = 60
const SUBTITLE_MAX_LENGTH = 160

function createPageOgMarkup(input: {
	page: PublicOgPage
	label: string
}): SatoriElement {
	return createOgFrame({
		label: input.label,
		children: [
			{
				type: 'div',
				props: {
					style: {
						fontSize: 64,
						fontWeight: 600,
						lineHeight: 1.15,
						letterSpacing: '-0.02em',
						marginBottom: 28,
						color: ogPalette.text,
					},
					children: truncateOgText(input.page.imageTitle, TITLE_MAX_LENGTH),
				},
			},
			{
				type: 'div',
				props: {
					style: {
						fontSize: 30,
						lineHeight: 1.4,
						color: ogPalette.muted,
					},
					children: truncateOgText(
						input.page.imageSubtitle,
						SUBTITLE_MAX_LENGTH,
					),
				},
			},
		],
	})
}

/**
 * Render the generic OG image for a registered public page. `label` is the
 * short line shown opposite the wordmark (typically the deployment host,
 * e.g. `heykody.dev`).
 */
export async function renderPageOgImage(input: {
	page: PublicOgPage
	label: string
}): Promise<Uint8Array<ArrayBuffer>> {
	return renderOgImage(createPageOgMarkup(input))
}
