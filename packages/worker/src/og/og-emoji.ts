/**
 * Satori's bundled Latin fonts have no color-emoji glyphs, so 🐨 and friends
 * render as .notdef boxes unless we supply images. Same approach as
 * epic-camp-tickets: `loadAdditionalAsset` + Twemoji SVG → data URI.
 */
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'

const TWEMOJI_SVG_BASE =
	'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg'
/** Bound the CDN hop so a hung jsDelivr request cannot stall OG rendering. */
const TWEMOJI_FETCH_TIMEOUT_MS = 5_000

const dataUriByEmoji = new Map<string, string>()

/** Test hook: clears the per-isolate Twemoji data-URI cache. */
export function resetTwemojiCache() {
	dataUriByEmoji.clear()
}

/**
 * Twemoji filenames are lowercase hex code points joined with `-`. Variation
 * selector U+FE0F is usually omitted from the file name (`❤️` → `2764.svg`),
 * so callers try the stripped form first and fall back to the raw sequence.
 */
export function emojiToTwemojiCodes(emoji: string): Array<string> {
	const raw = [...emoji]
		.map((char) => char.codePointAt(0)?.toString(16))
		.filter((code): code is string => code !== undefined)
		.join('-')
	if (raw === '') return []

	const stripped = raw.replaceAll('-fe0f', '').replace(/^fe0f-/, '')
	if (stripped === '' || stripped === raw) return [raw]
	return [stripped, raw]
}

export function twemojiSvgUrl(code: string): string {
	return `${TWEMOJI_SVG_BASE}/${code}.svg`
}

function svgToDataUri(svg: string): string {
	return `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(svg))}`
}

async function fetchTwemojiSvg(code: string): Promise<string | null> {
	const response = await fetch(twemojiSvgUrl(code), {
		signal: AbortSignal.timeout(TWEMOJI_FETCH_TIMEOUT_MS),
	})
	if (!response.ok) return null
	const svg = await response.text()
	return svg.includes('<svg') ? svg : null
}

export async function loadTwemojiDataUri(emoji: string): Promise<string> {
	const cached = dataUriByEmoji.get(emoji)
	if (cached !== undefined) return cached

	for (const code of emojiToTwemojiCodes(emoji)) {
		try {
			const svg = await fetchTwemojiSvg(code)
			if (!svg) continue
			const dataUri = svgToDataUri(svg)
			dataUriByEmoji.set(emoji, dataUri)
			return dataUri
		} catch {
			continue
		}
	}
	return ''
}

/** Satori `loadAdditionalAsset` callback used by every OG render. */
export async function loadAdditionalOgAsset(
	languageCode: string,
	segment: string,
): Promise<string> {
	if (languageCode === 'emoji') {
		return loadTwemojiDataUri(segment)
	}
	return ''
}
