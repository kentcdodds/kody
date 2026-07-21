import {
	absolutizeDocumentHead,
	DOCUMENT_HEAD_ATTR,
	resolveDocumentHead,
	type ResolvedDocumentHead,
} from '#app/document-head.ts'
import { type AppLoaderData } from '#app/loader-data.ts'

export {
	DEFAULT_DOCUMENT_TITLE,
	NOT_FOUND_DOCUMENT_TITLE,
	resolveDocumentHead,
	resolveDocumentTitle,
} from '#app/document-head.ts'

function removeManagedHeadNodes(head: HTMLHeadElement) {
	for (const node of head.querySelectorAll(`[${DOCUMENT_HEAD_ATTR}]`)) {
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
}

function applyResolvedDocumentHead(resolved: ResolvedDocumentHead) {
	const head = document.head
	document.title = resolved.title

	// Drop previous managed tags first so leaving a public page also clears
	// stale OG/canonical/RSS nodes that no longer apply.
	removeManagedHeadNodes(head)

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
		appendLink(head, `link:${index}`, {
			rel: link.rel,
			href: link.href,
			type: link.type,
			title: link.title,
		})
	}
}

/**
 * Sync managed document head tags from the current route + optional loader
 * data. Title, OG/Twitter, canonical, and registry links are updated/cleared
 * together so SPA navigations do not leave the previous page's metadata behind.
 */
export function applyDocumentHead(
	pathname: string,
	loaderData?: Partial<AppLoaderData>,
): void {
	if (typeof document === 'undefined') return
	const resolved = absolutizeDocumentHead(
		resolveDocumentHead(pathname, loaderData),
		window.location.origin,
	)
	applyResolvedDocumentHead(resolved)
}
