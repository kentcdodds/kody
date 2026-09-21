/**
 * Lightweight `**span**` markers for Open Graph headlines.
 *
 * The PNG paints emphasized runs in the card accent. `og:title` uses the same
 * words with the markers removed and author line breaks collapsed to spaces.
 * An unbalanced marker stays literal so a stray `**` is not eaten.
 */

export type OgEmphasisRun = {
	text: string
	emphasis: boolean
}

const emphasisMarker = '**'

export function parseOgEmphasis(text: string): Array<OgEmphasisRun> {
	const parts = text.split(emphasisMarker)
	if (parts.length % 2 === 0) {
		return [{ text, emphasis: false }]
	}
	return parts
		.map((part, index) => ({
			text: part,
			emphasis: index % 2 === 1,
		}))
		.filter((part) => part.text.length > 0)
}

/**
 * Meta copy: drop balanced `**` on each line, then join hard breaks with
 * single spaces. Lines are parsed separately so a stray marker on one line
 * cannot put asterisks back into the others. That matches the PNG, which
 * also parses one line at a time.
 */
export function stripOgEmphasis(text: string): string {
	return text
		.split('\n')
		.map((line) =>
			parseOgEmphasis(line)
				.map((part) => part.text)
				.join('')
				.replace(/\s+/g, ' ')
				.trim(),
		)
		.filter((line) => line.length > 0)
		.join(' ')
}
