import { resolveDocumentTitle } from '#app/document-title.ts'
import { type AppLoaderData } from '#app/loader-data.ts'

export {
	DEFAULT_DOCUMENT_TITLE,
	NOT_FOUND_DOCUMENT_TITLE,
	resolveDocumentTitle,
} from '#app/document-title.ts'

/** Sync `document.title` from the current route + optional loader data. */
export function applyDocumentTitle(
	pathname: string,
	loaderData?: Partial<AppLoaderData>,
): void {
	if (typeof document === 'undefined') return
	document.title = resolveDocumentTitle(pathname, loaderData)
}
