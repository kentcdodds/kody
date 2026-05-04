import { unleashedRequest, type UnleashedAjaxAction } from './request.ts'
import { extractElements, type UnleashedRecord } from './xml.ts'

export type UnleashedListResult = {
	items: Array<UnleashedRecord>
	xml: string
}

export async function listUnleashed(input: {
	action: UnleashedAjaxAction
	comp: string
	xmlBody: string
	tagNames: Array<string>
	reason: string
	updater?: string
}): Promise<UnleashedListResult> {
	const result = await unleashedRequest({
		action: input.action,
		comp: input.comp,
		xmlBody: input.xmlBody,
		updater: input.updater,
		reason: input.reason,
	})
	for (const tagName of input.tagNames) {
		const items = extractElements(result.xml, tagName)
		if (items.length > 0) {
			return { items, xml: result.xml }
		}
	}
	return { items: [], xml: result.xml }
}
