import { unleashedRequest } from './internal/request.ts'
import { extractElements, type UnleashedRecord } from './internal/xml.ts'

const defaultReason =
	'Reading the Access Networks Unleashed mesh topology for operator review.'

/** Read mesh topology information from the controller. */
export async function getMeshInfo(input: { reason?: string } = {}) {
	const result = await unleashedRequest({
		action: 'getstat',
		comp: 'system',
		xmlBody: '<mesh/>',
		reason: input.reason ?? defaultReason,
	})
	const meshes = extractElements(result.xml, 'mesh')
	const mesh: UnleashedRecord = meshes[0] ?? {}
	return { mesh, xml: result.xml }
}
