import { getOgPalette, type OgTheme } from '#worker/og/palette.ts'
import {
	createOgFrame,
	renderOgImage,
	truncateOgText,
	type SatoriElement,
} from '#worker/og/render.ts'

const TITLE_MAX_LENGTH = 80
const DESCRIPTION_MAX_LENGTH = 160
const BLOG_AUTHOR = 'Kent C. Dodds'

export type BlogPostOgImageInput = {
	/** Card palette; defaults to `OG_DEFAULT_THEME`. */
	theme?: OgTheme
	title: string
	description: string
	date: string
}

function createBlogPostOgMarkup(input: BlogPostOgImageInput): SatoriElement {
	const palette = getOgPalette(input.theme)
	return createOgFrame({
		theme: input.theme,
		label: 'Blog',
		children: [
			{
				type: 'div',
				props: {
					style: {
						fontFamily: 'Bricolage Grotesque',
						fontSize: 52,
						fontWeight: 700,
						lineHeight: 1.2,
						letterSpacing: '-0.02em',
						marginBottom: 24,
						color: palette.text,
					},
					children: truncateOgText(input.title, TITLE_MAX_LENGTH),
				},
			},
			{
				type: 'div',
				props: {
					style: {
						fontSize: 28,
						lineHeight: 1.4,
						color: palette.textMuted,
						marginBottom: 32,
					},
					children: truncateOgText(input.description, DESCRIPTION_MAX_LENGTH),
				},
			},
			{
				type: 'div',
				props: {
					style: {
						display: 'flex',
						fontSize: 22,
						color: palette.textMuted,
					},
					children: `${input.date} · ${BLOG_AUTHOR}`,
				},
			},
		],
	})
}

export async function renderBlogPostOgImage(
	input: BlogPostOgImageInput,
): Promise<Uint8Array<ArrayBuffer>> {
	return renderOgImage(createBlogPostOgMarkup(input))
}
