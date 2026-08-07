import {
	ContentBlockSchema,
	type ContentBlock,
} from '@modelcontextprotocol/sdk/types.js'

/**
 * Explicit markers used at the synthesized MCP-server / remote-connector
 * capability boundary (and understood by execute) so protocol content is never
 * inferred from arbitrary application `{ content: [] }` objects.
 */
export const mcpContentMarker = '__mcpContent' as const
export const mcpIsErrorMarker = '__mcpIsError' as const
export const mcpStructuredContentMarker = '__mcpStructuredContent' as const

/**
 * When downstream `structuredContent` uses reserved marker names, those fields
 * are moved here so they cannot become trusted control markers.
 */
export const reservedStructuredFieldCollisionKey =
	'_kodyMcpReservedFieldCollisions' as const

/**
 * Soft cap for protocol content blocks (images/audio/resources) returned through
 * execute / persistence. Higher than the default JSON `responseLimit` (102_400)
 * so valid images survive, but still bounded.
 *
 * Rationale: MCP image/audio `data` is base64 (~4/3 expansion). A ~132,550-byte
 * WebP is ~177 KiB of base64 JSON — comfortably under 512 KiB — while multi-MiB
 * dumps are rejected before `ContentBlockSchema` runs `atob`.
 */
export const defaultMcpContentLimitBytes = 524_288

/** Max content blocks accepted from untrusted downstream / execute payloads. */
export const maxMcpContentBlockCount = 32

export type DownstreamMcpResultSource = {
	kind: 'mcp-server' | 'remote-connector' | 'execute'
	/** Human-readable label for errors, e.g. `linear:screenshot`. */
	label: string
}

export type DownstreamMcpToolResult = {
	content?: unknown
	structuredContent?: unknown
	isError?: boolean
}

export type McpPassthroughExtraction = {
	content: Array<ContentBlock> | null
	/** Structured data for execute `structuredContent.result` / code use. */
	structuredResult: unknown | null
	isError: boolean
}

export type PersistedRawContentBound = {
	rawContent: Array<ContentBlock> | null
	rawContentOmitted: null | {
		note: string
		returnedBytes: number
		blockCount: number
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReservedMarkerKey(key: string) {
	return (
		key === mcpContentMarker ||
		key === mcpIsErrorMarker ||
		key === mcpStructuredContentMarker
	)
}

function sourcePrefix(source: DownstreamMcpResultSource) {
	switch (source.kind) {
		case 'mcp-server':
			return `MCP server "${source.label}"`
		case 'remote-connector':
			return `Remote connector "${source.label}"`
		case 'execute':
			return `Execute ${source.label}`
		default: {
			const _exhaustive: never = source.kind
			return _exhaustive
		}
	}
}

/**
 * Move reserved marker keys out of structured content so they cannot become
 * trusted control markers when the object is returned or re-extracted.
 */
export function sanitizeStructuredContentRecord(
	structured: Record<string, unknown>,
): Record<string, unknown> {
	const clean: Record<string, unknown> = {}
	const collisions: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(structured)) {
		if (isReservedMarkerKey(key)) {
			collisions[key] = value
		} else {
			clean[key] = value
		}
	}

	if (Object.keys(collisions).length === 0) {
		return clean
	}

	if (reservedStructuredFieldCollisionKey in clean) {
		collisions[reservedStructuredFieldCollisionKey] =
			clean[reservedStructuredFieldCollisionKey]
		delete clean[reservedStructuredFieldCollisionKey]
	}
	clean[reservedStructuredFieldCollisionKey] = collisions
	return clean
}

function formatContentBlockIssue(block: unknown, index: number) {
	if (!isRecord(block)) {
		return `content[${index}] is not an object`
	}
	const type = typeof block.type === 'string' ? block.type : 'unknown'
	if (
		(type === 'image' || type === 'audio') &&
		'url' in block &&
		typeof block.data !== 'string'
	) {
		return `content[${index}] type=${type} uses a URL without base64 "data"; Kody does not fetch image/audio URLs. Return protocol-valid { type: '${type}', data, mimeType }.`
	}
	if (type === 'image' || type === 'audio') {
		return `content[${index}] type=${type} is not protocol-valid (need base64 "data" and "mimeType")`
	}
	return `content[${index}] type=${type} is not a protocol-valid MCP content block`
}

export function getUtf8ByteLength(value: string) {
	return new TextEncoder().encode(value).byteLength
}

/**
 * Estimate untrusted content payload size without decoding base64 (`atob`).
 * Used to reject oversized payloads before `ContentBlockSchema.safeParse`.
 */
export function estimateUntrustedMcpContentPayloadBytes(
	content: ReadonlyArray<unknown>,
): number {
	let total = 2 // []
	for (let index = 0; index < content.length; index++) {
		if (index > 0) total += 1 // comma
		const entry = content[index]
		if (!isRecord(entry)) {
			total += getUtf8ByteLength(JSON.stringify(entry) ?? 'null')
			continue
		}
		total += 2 // {}
		let fieldIndex = 0
		for (const [key, value] of Object.entries(entry)) {
			if (fieldIndex > 0) total += 1
			total += getUtf8ByteLength(JSON.stringify(key) ?? '""') + 1
			if (typeof value === 'string') {
				// Avoid allocating a second copy of huge base64 strings. ASCII
				// media payloads need no JSON escapes, so length+2 is exact;
				// remaining cases are bounded by the same order of magnitude.
				total += value.length + 2
			} else {
				total += getUtf8ByteLength(JSON.stringify(value) ?? 'null')
			}
			fieldIndex += 1
		}
	}
	return total
}

/**
 * Validate MCP content blocks from a downstream tool result or execute return.
 * Bounds block count and payload size before schema parse (avoids unbounded
 * `atob`); does not fetch URLs or rewrite shapes.
 */
export function validateDownstreamMcpContentBlocks(
	content: unknown,
	source: DownstreamMcpResultSource,
	options?: {
		maxBlockCount?: number
		maxPayloadBytes?: number
	},
): Array<ContentBlock> {
	const maxBlockCount = options?.maxBlockCount ?? maxMcpContentBlockCount
	const maxPayloadBytes =
		options?.maxPayloadBytes ?? defaultMcpContentLimitBytes

	if (!Array.isArray(content)) {
		throw new Error(
			`${sourcePrefix(source)} returned invalid MCP content (expected an array of content blocks).`,
		)
	}

	if (content.length > maxBlockCount) {
		throw new Error(
			`${sourcePrefix(source)} returned too many MCP content blocks (${content.length.toLocaleString()} > limit ${maxBlockCount.toLocaleString()}).`,
		)
	}

	const estimatedBytes = estimateUntrustedMcpContentPayloadBytes(content)
	if (estimatedBytes > maxPayloadBytes) {
		throw new Error(
			`${sourcePrefix(source)} returned MCP content estimated at ${estimatedBytes.toLocaleString()} bytes, exceeding content limit ${maxPayloadBytes.toLocaleString()} bytes before validation. Reduce image/audio payload size or split the response.`,
		)
	}

	const blocks: Array<ContentBlock> = []
	for (let index = 0; index < content.length; index++) {
		const entry = content[index]
		const parsed = ContentBlockSchema.safeParse(entry)
		if (!parsed.success) {
			throw new Error(
				`${sourcePrefix(source)} returned malformed MCP content: ${formatContentBlockIssue(entry, index)}.`,
			)
		}
		blocks.push(parsed.data)
	}
	return blocks
}

function hasNonTextContent(blocks: Array<ContentBlock>) {
	return blocks.some((block) => block.type !== 'text')
}

/**
 * Convert a downstream MCP CallToolResult into a capability return value.
 * Non-text content and isError are preserved via explicit markers; structured
 * content remains available for code (spread + companion marker). Reserved
 * marker keys inside structuredContent are isolated, never trusted as control.
 */
export function wrapDownstreamMcpToolResult(
	result: DownstreamMcpToolResult,
	source: DownstreamMcpResultSource,
): Record<string, unknown> {
	const hasStructured =
		result.structuredContent !== undefined &&
		result.structuredContent !== null &&
		typeof result.structuredContent === 'object' &&
		!Array.isArray(result.structuredContent)

	const structuredRecord = hasStructured
		? sanitizeStructuredContentRecord(
				result.structuredContent as Record<string, unknown>,
			)
		: null

	const contentBlocks =
		result.content === undefined
			? null
			: validateDownstreamMcpContentBlocks(result.content, source)

	const isError = result.isError === true
	const needsContentPassthrough =
		contentBlocks !== null &&
		(hasNonTextContent(contentBlocks) || !hasStructured || isError)

	if (needsContentPassthrough) {
		return {
			...(structuredRecord ?? {}),
			[mcpContentMarker]: contentBlocks,
			...(structuredRecord
				? { [mcpStructuredContentMarker]: structuredRecord }
				: {}),
			...(isError ? { [mcpIsErrorMarker]: true } : {}),
		}
	}

	if (isError && hasStructured && structuredRecord) {
		return {
			...structuredRecord,
			[mcpStructuredContentMarker]: structuredRecord,
			[mcpIsErrorMarker]: true,
		}
	}

	if (isError) {
		return {
			[mcpContentMarker]: contentBlocks ?? [
				{ type: 'text', text: 'Tool reported an error.' },
			],
			[mcpIsErrorMarker]: true,
		}
	}

	if (hasStructured && structuredRecord) {
		return structuredRecord
	}

	return {
		content: contentBlocks ?? [],
		isError: false,
	}
}

function stripPassthroughMarkers(
	value: Record<string, unknown>,
): Record<string, unknown> | null {
	const next: Record<string, unknown> = {}
	for (const [key, entry] of Object.entries(value)) {
		if (isReservedMarkerKey(key)) {
			continue
		}
		next[key] = entry
	}
	return Object.keys(next).length > 0 ? next : null
}

/**
 * Extract explicit MCP passthrough markers from an execute return value.
 * Only recognizes `__mcpContent` / companion markers — never arbitrary
 * `{ content: [] }` application objects. Content is not schema-validated here;
 * callers at trust boundaries (execute egress) must revalidate.
 */
export function extractMcpPassthrough(
	value: unknown,
): McpPassthroughExtraction | null {
	if (!isRecord(value)) return null

	const hasContentMarker =
		mcpContentMarker in value && Array.isArray(value[mcpContentMarker])
	const hasIsErrorMarker = value[mcpIsErrorMarker] === true
	const hasStructuredMarker =
		mcpStructuredContentMarker in value &&
		isRecord(value[mcpStructuredContentMarker])

	if (!hasContentMarker && !hasIsErrorMarker && !hasStructuredMarker) {
		return null
	}

	const content = hasContentMarker
		? (value[mcpContentMarker] as Array<ContentBlock>)
		: null

	const structuredResult = hasStructuredMarker
		? sanitizeStructuredContentRecord(
				value[mcpStructuredContentMarker] as Record<string, unknown>,
			)
		: hasContentMarker || hasIsErrorMarker
			? stripPassthroughMarkers(value)
			: null

	return {
		content,
		structuredResult,
		isError: hasIsErrorMarker,
	}
}

export function measureMcpContentBytes(blocks: Array<ContentBlock>) {
	return getUtf8ByteLength(JSON.stringify(blocks) ?? '[]')
}

export function limitMcpContentBlocks(
	blocks: Array<ContentBlock>,
	limitBytes: number,
):
	| {
			ok: true
			blocks: Array<ContentBlock>
			returnedBytes: number
	  }
	| {
			ok: false
			returnedBytes: number
			note: string
	  } {
	const returnedBytes = measureMcpContentBytes(blocks)
	if (returnedBytes <= limitBytes) {
		return { ok: true, blocks, returnedBytes }
	}
	return {
		ok: false,
		returnedBytes,
		note: `MCP content was ${returnedBytes.toLocaleString()} bytes, exceeding content limit ${limitBytes.toLocaleString()} bytes; content was not returned. Reduce image/audio payload size or split the response.`,
	}
}

/**
 * Bound protocol content before durable package-invocation persistence.
 * Oversized media is omitted with safe metadata (never stored unbounded).
 */
export function boundRawContentForPersistence(
	content: Array<ContentBlock> | null,
	limitBytes: number = defaultMcpContentLimitBytes,
): PersistedRawContentBound {
	if (!content || content.length === 0) {
		return { rawContent: null, rawContentOmitted: null }
	}
	const limited = limitMcpContentBlocks(content, limitBytes)
	if (!limited.ok) {
		return {
			rawContent: null,
			rawContentOmitted: {
				note: limited.note,
				returnedBytes: limited.returnedBytes,
				blockCount: content.length,
			},
		}
	}
	return { rawContent: limited.blocks, rawContentOmitted: null }
}

/**
 * Shape package-invocation storage so control markers and unbounded base64 are
 * not written into the durable `result` blob. Media lives in `rawContent` only
 * when within the content cap.
 */
export function persistableExecutionArtifacts(value: unknown): {
	result: unknown
	rawContent: Array<ContentBlock> | null
	rawContentOmitted: PersistedRawContentBound['rawContentOmitted']
} {
	const passthrough = extractMcpPassthrough(value)
	if (!passthrough) {
		return { result: value, rawContent: null, rawContentOmitted: null }
	}

	const result =
		passthrough.structuredResult !== null ? passthrough.structuredResult : null
	const bounded = boundRawContentForPersistence(passthrough.content)
	return {
		result,
		rawContent: bounded.rawContent,
		rawContentOmitted: bounded.rawContentOmitted,
	}
}
