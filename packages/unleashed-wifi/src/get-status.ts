import { unleashedRequest } from './internal/request.ts'
import { extractElements, type UnleashedRecord } from './internal/xml.ts'

export type UnleashedSystemSummary = {
	system: UnleashedRecord
	identity: UnleashedRecord
	sysinfo: UnleashedRecord
	unleashedNetwork: UnleashedRecord
	xml: string
}

const defaultReason =
	'Reading the live Access Networks Unleashed system summary for the operator review.'

/** Read the live Unleashed controller system summary. */
export async function getStatus(input: { reason?: string } = {}) {
	const result = await unleashedRequest({
		action: 'getstat',
		comp: 'system',
		xmlBody: '<identity/><sysinfo/><unleashed-network/>',
		reason: input.reason ?? defaultReason,
	})
	const summary: UnleashedSystemSummary = {
		system: extractElements(result.xml, 'system')[0] ?? {},
		identity: extractElements(result.xml, 'identity')[0] ?? {},
		sysinfo: extractElements(result.xml, 'sysinfo')[0] ?? {},
		unleashedNetwork: extractElements(result.xml, 'unleashed-network')[0] ?? {},
		xml: result.xml,
	}
	return summary
}
