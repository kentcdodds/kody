import { ogPalette } from '#worker/og/palette.ts'
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
	title: string
	description: string
	date: string
}

function createBlogPostOgMarkup(input: BlogPostOgImageInput): SatoriElement {
	return createOgFrame({
		label: 'Blog',
		children: [
			{
				type: 'div',
				props: {
					style: {
						fontSize: 52,
						fontWeight: 600,
						lineHeight: 1.2,
						letterSpacing: '-0.02em',
						marginBottom: 24,
						color: ogPalette.text,
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
						color: ogPalette.muted,
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
						color: ogPalette.muted,
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
