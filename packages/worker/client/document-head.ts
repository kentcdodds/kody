import {
	absolutizeDocumentHead,
	CANONICAL_ORIGIN_META_NAME,
	DOCUMENT_HEAD_ATTR,
	resolveDocumentHead,
	type ResolvedDocumentHead,
} from '#universal/document-head.ts'
import { type AppLoaderData } from '#universal/loader-data.ts'

function managedStylesheetLinks(head: HTMLHeadElement) {
	return Array.from(
		head.querySelectorAll<HTMLLinkElement>(
			`link[rel="stylesheet"][${DOCUMENT_HEAD_ATTR}]`,
		),
	)
}

function stylesheetHrefs(resolved: ResolvedDocumentHead) {
	return new Set(
		(resolved.links ?? [])
			.filter((link) => link.rel === 'stylesheet')
			.map((link) => link.href),
	)
}

// A wanted stylesheet stays in place: re-inserting it would unapply it until
// the reload finishes and paint the page unstyled in between.
function removeManagedHeadNodes(
	head: HTMLHeadElement,
	keepStylesheets: ReadonlySet<string>,
) {
	for (const node of head.querySelectorAll(`[${DOCUMENT_HEAD_ATTR}]`)) {
		if (
			node instanceof HTMLLinkElement &&
			node.rel === 'stylesheet' &&
			keepStylesheets.has(node.getAttribute('href') ?? '')
		) {
			continue
		}
		node.remove()
	}
}

function appendMeta(
	head: HTMLHeadElement,
	key: string,
	attrs: Record<string, string>,
) {
	const element = document.createElement('meta')
	element.setAttribute(DOCUMENT_HEAD_ATTR, key)
	for (const [name, value] of Object.entries(attrs)) {
		element.setAttribute(name, value)
	}
	head.append(element)
}

function appendLink(
	head: HTMLHeadElement,
	key: string,
	attrs: Record<string, string | undefined>,
) {
	const element = document.createElement('link')
	element.setAttribute(DOCUMENT_HEAD_ATTR, key)
	for (const [name, value] of Object.entries(attrs)) {
		if (value === undefined) continue
		element.setAttribute(name, value)
	}
	head.append(element)
	return element
}

function applyResolvedDocumentHead(resolved: ResolvedDocumentHead) {
	const head = document.head
	document.title = resolved.title

	// Drop previous managed tags first so leaving a public page also clears
	// stale OG/canonical/RSS nodes that no longer apply.
	const keepStylesheets = stylesheetHrefs(resolved)
	removeManagedHeadNodes(head, keepStylesheets)
	const presentStylesheets = new Set(
		managedStylesheetLinks(head).map((link) => link.getAttribute('href')),
	)

	if (resolved.description) {
		appendMeta(head, 'description', {
			name: 'description',
			content: resolved.description,
		})
	}

	if (resolved.og) {
		appendMeta(head, 'og:title', {
			property: 'og:title',
			content: resolved.og.title,
		})
		appendMeta(head, 'og:description', {
			property: 'og:description',
			content: resolved.og.description,
		})
		appendMeta(head, 'og:image', {
			property: 'og:image',
			content: resolved.og.imageUrl,
		})
		appendMeta(head, 'og:type', {
			property: 'og:type',
			content: 'website',
		})
		if (resolved.canonicalUrl) {
			appendMeta(head, 'og:url', {
				property: 'og:url',
				content: resolved.canonicalUrl,
			})
		}
		appendMeta(head, 'twitter:card', {
			name: 'twitter:card',
			content: 'summary_large_image',
		})
		appendMeta(head, 'twitter:title', {
			name: 'twitter:title',
			content: resolved.og.title,
		})
		appendMeta(head, 'twitter:description', {
			name: 'twitter:description',
			content: resolved.og.description,
		})
		appendMeta(head, 'twitter:image', {
			name: 'twitter:image',
			content: resolved.og.imageUrl,
		})
	}

	if (resolved.canonicalUrl) {
		appendLink(head, 'canonical', {
			rel: 'canonical',
			href: resolved.canonicalUrl,
		})
	}

	for (const [index, link] of (resolved.links ?? []).entries()) {
		if (link.rel === 'stylesheet' && presentStylesheets.has(link.href)) {
			continue
		}
		appendLink(head, `link:${index}`, {
			rel: link.rel,
			href: link.href,
			type: link.type,
			title: link.title,
		})
	}
}

function resolveClientDocumentHead(
	pathname: string,
	loaderData: Partial<AppLoaderData> | undefined,
	search: string,
) {
	// Reuse the canonical origin the server rendered with so SPA navigations
	// on a dual-served legacy host keep canonical/OG URLs on the canonical
	// domain instead of reverting to the current origin.
	const canonicalOrigin =
		document
			.querySelector(`meta[name="${CANONICAL_ORIGIN_META_NAME}"]`)
			?.getAttribute('content') || window.location.origin
	return absolutizeDocumentHead(
		resolveDocumentHead(pathname, loaderData, search),
		canonicalOrigin,
	)
}

// Load outcome per inserted stylesheet, independent of any one navigation's
// abort signal: a superseding navigation that wants the same href awaits the
// load already in flight instead of treating the link as ready.
const stylesheetLoads = new WeakMap<HTMLLinkElement, Promise<boolean>>()

function trackStylesheetLoad(link: HTMLLinkElement) {
	const load = new Promise<boolean>((resolve) => {
		link.addEventListener('load', () => resolve(true), { once: true })
		link.addEventListener(
			'error',
			() => {
				// Drop the failed link so the next navigation retries the fetch.
				link.remove()
				resolve(false)
			},
			{ once: true },
		)
	})
	stylesheetLoads.set(link, load)
	return load
}

function untilAborted(signal: AbortSignal) {
	return new Promise<'aborted'>((resolve) => {
		if (signal.aborted) resolve('aborted')
		signal.addEventListener('abort', () => resolve('aborted'), { once: true })
	})
}

/**
 * Sync managed document head tags from the destination route + optional
 * loader data. Title, OG/Twitter, canonical, and registry links are
 * updated/cleared together so SPA navigations do not leave the previous
 * page's metadata behind.
 *
 * Stylesheets the destination adds are inserted and loaded now, while the
 * previous page is still on screen (route head stylesheets are scoped to
 * their page, so the early insert leaves the current page alone). The
 * returned commit applies the rest — title, metadata, and removal of the
 * previous page's stylesheets — and must run in the same task as the DOM
 * swap so neither page paints without its styles. Resolves `null` when a
 * destination stylesheet failed to load; the caller should fall back to a
 * document navigation rather than paint the route without it.
 */
export async function prepareDocumentHead(
	pathname: string,
	loaderData: Partial<AppLoaderData> | undefined,
	search: string,
	signal: AbortSignal,
): Promise<(() => void) | null> {
	if (typeof document === 'undefined') return () => {}
	const resolved = resolveClientDocumentHead(pathname, loaderData, search)
	const head = document.head
	const loads: Array<Promise<boolean>> = []
	for (const [index, link] of (resolved.links ?? []).entries()) {
		if (link.rel !== 'stylesheet') continue
		let element = managedStylesheetLinks(head).find(
			(candidate) => candidate.getAttribute('href') === link.href,
		)
		if (element?.sheet) continue
		let load = element ? stylesheetLoads.get(element) : undefined
		if (!element || !load) {
			// An untracked link without a sheet already failed (SSR); replace it.
			element?.remove()
			element = appendLink(head, `link:${index}`, {
				rel: link.rel,
				href: link.href,
				type: link.type,
				title: link.title,
			})
			load = trackStylesheetLoad(element)
		}
		loads.push(load)
	}
	const outcome = await Promise.race([Promise.all(loads), untilAborted(signal)])
	if (outcome === 'aborted') return () => {}
	if (outcome.includes(false)) return null
	return () => applyResolvedDocumentHead(resolved)
}
