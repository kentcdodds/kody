import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server'

/** SEP-2640 Skills-over-MCP extension identifier. */
export const skillsExtensionId = 'io.modelcontextprotocol/skills'

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageAdvertisesSkillsExtension(message: unknown) {
	if (!isRecord(message) || !isRecord(message['params'])) return false
	const meta = message['params']['_meta']
	if (!isRecord(meta)) return false
	const clientCapabilities = meta[CLIENT_CAPABILITIES_META_KEY]
	if (!isRecord(clientCapabilities)) return false
	const extensions = clientCapabilities['extensions']
	if (!isRecord(extensions)) return false
	return isRecord(extensions[skillsExtensionId])
}

/**
 * Whether the modern per-request `_meta` envelope declares the skills
 * extension in `clientCapabilities.extensions`. Reads the already-parsed
 * request body so the request stream is never consumed twice.
 */
export function clientAdvertisesSkillsExtension(parsedBody: unknown) {
	const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody]
	return messages.some(messageAdvertisesSkillsExtension)
}
