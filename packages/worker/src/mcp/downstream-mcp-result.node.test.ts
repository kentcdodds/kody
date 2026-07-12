import { expect, test, vi } from 'vitest'
import {
	boundRawContentForPersistence,
	defaultMcpContentLimitBytes,
	estimateUntrustedMcpContentPayloadBytes,
	extractMcpPassthrough,
	limitMcpContentBlocks,
	maxMcpContentBlockCount,
	measureMcpContentBytes,
	mcpContentMarker,
	mcpIsErrorMarker,
	mcpStructuredContentMarker,
	persistableExecutionArtifacts,
	reservedStructuredFieldCollisionKey,
	sanitizeStructuredContentRecord,
	validateDownstreamMcpContentBlocks,
	wrapDownstreamMcpToolResult,
} from '#mcp/downstream-mcp-result.ts'

/** Minimal valid 1×1 WebP (lossy) as base64. */
const minimalWebpBase64 =
	'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA='

function oversizedBase64(byteLength: number) {
	// 'A' is valid base64 alphabet; length must be multiple of 4 for atob.
	const rawLength = Math.ceil(byteLength / 4) * 4
	return 'A'.repeat(rawLength)
}

test('downstream MCP wrap preserves WebP images, structured+content, oversized bounds, malformed errors, resources, and isError', () => {
	const webpBlock = {
		type: 'image' as const,
		data: minimalWebpBase64,
		mimeType: 'image/webp',
	}
	const resourceBlock = {
		type: 'resource' as const,
		resource: {
			uri: 'mcp://example/doc',
			mimeType: 'text/plain',
			text: 'hello resource',
		},
	}
	const resourceLinkBlock = {
		type: 'resource_link' as const,
		uri: 'https://example.com/doc',
		name: 'Example doc',
	}
	const audioBlock = {
		type: 'audio' as const,
		data: 'AAAA',
		mimeType: 'audio/wav',
	}

	const webpWrapped = wrapDownstreamMcpToolResult(
		{
			content: [webpBlock, { type: 'text', text: 'chart' }],
			isError: false,
		},
		{ kind: 'mcp-server', label: 'charts:render' },
	)
	expect(webpWrapped).toMatchObject({
		[mcpContentMarker]: [webpBlock, { type: 'text', text: 'chart' }],
	})
	expect(extractMcpPassthrough(webpWrapped)?.content).toEqual([
		webpBlock,
		{ type: 'text', text: 'chart' },
	])

	const structuredAndImage = wrapDownstreamMcpToolResult(
		{
			content: [webpBlock],
			structuredContent: { chartId: 'c1', width: 640 },
			isError: false,
		},
		{ kind: 'remote-connector', label: 'home:screenshot' },
	)
	expect(structuredAndImage).toMatchObject({
		chartId: 'c1',
		width: 640,
		[mcpContentMarker]: [webpBlock],
		[mcpStructuredContentMarker]: { chartId: 'c1', width: 640 },
	})
	expect(extractMcpPassthrough(structuredAndImage)).toEqual({
		content: [webpBlock],
		structuredResult: { chartId: 'c1', width: 640 },
		isError: false,
	})

	// ~133KB binary WebP ≈ ~177KB base64 must fit under the media cap.
	const reportedWebpBinaryBytes = 132_550
	const reportedWebpBase64 = oversizedBase64(
		Math.ceil(reportedWebpBinaryBytes / 3) * 4,
	)
	expect(reportedWebpBase64.length).toBeGreaterThan(170_000)
	expect(reportedWebpBase64.length).toBeLessThan(defaultMcpContentLimitBytes)
	const reportedWebpBlocks = [
		{
			type: 'image' as const,
			data: reportedWebpBase64,
			mimeType: 'image/webp',
		},
	]
	expect(measureMcpContentBytes(reportedWebpBlocks)).toBeLessThan(
		defaultMcpContentLimitBytes,
	)
	expect(
		limitMcpContentBlocks(reportedWebpBlocks, defaultMcpContentLimitBytes),
	).toMatchObject({ ok: true, blocks: reportedWebpBlocks })
	expect(
		validateDownstreamMcpContentBlocks(reportedWebpBlocks, {
			kind: 'mcp-server',
			label: 'vision:shot',
		}),
	).toEqual(reportedWebpBlocks)

	const largeData = oversizedBase64(110_000)
	const largeBlocks = [
		{
			type: 'image' as const,
			data: largeData,
			mimeType: 'image/webp',
		},
	]
	expect(measureMcpContentBytes(largeBlocks)).toBeGreaterThan(102_400)
	expect(limitMcpContentBlocks(largeBlocks, 102_400)).toMatchObject({
		ok: false,
	})
	expect(
		limitMcpContentBlocks(largeBlocks, defaultMcpContentLimitBytes),
	).toMatchObject({
		ok: true,
		blocks: largeBlocks,
	})

	const tooLarge = [
		{
			type: 'image' as const,
			data: oversizedBase64(defaultMcpContentLimitBytes + 50_000),
			mimeType: 'image/png',
		},
	]
	const overContentLimit = limitMcpContentBlocks(
		tooLarge,
		defaultMcpContentLimitBytes,
	)
	expect(overContentLimit.ok).toBe(false)
	if (!overContentLimit.ok) {
		expect(overContentLimit.note).toContain('exceeding content limit')
	}

	expect(() =>
		validateDownstreamMcpContentBlocks(
			[{ type: 'image', url: 'https://evil.example/x.png' }],
			{ kind: 'mcp-server', label: 'evil:img' },
		),
	).toThrow(/evil:img[\s\S]*does not fetch image\/audio URLs/)

	expect(() =>
		wrapDownstreamMcpToolResult(
			{
				content: [{ type: 'image', data: '!!!', mimeType: 'image/png' }],
			},
			{ kind: 'remote-connector', label: 'cam:snap' },
		),
	).toThrow(/cam:snap[\s\S]*malformed MCP content/)

	// Arbitrary application { content: [] } is not treated as protocol content.
	expect(extractMcpPassthrough({ content: [webpBlock], ok: true })).toBeNull()

	const withResources = wrapDownstreamMcpToolResult(
		{
			content: [resourceBlock, resourceLinkBlock, audioBlock],
			structuredContent: { ok: true },
		},
		{ kind: 'mcp-server', label: 'docs:get' },
	)
	expect(extractMcpPassthrough(withResources)?.content).toEqual([
		resourceBlock,
		resourceLinkBlock,
		audioBlock,
	])

	const errorWithStructured = wrapDownstreamMcpToolResult(
		{
			content: [{ type: 'text', text: 'permission denied' }],
			structuredContent: { code: 'forbidden' },
			isError: true,
		},
		{ kind: 'mcp-server', label: 'linear:create_issue' },
	)
	expect(extractMcpPassthrough(errorWithStructured)).toEqual({
		content: [{ type: 'text', text: 'permission denied' }],
		structuredResult: { code: 'forbidden' },
		isError: true,
	})
	expect(errorWithStructured).toMatchObject({
		code: 'forbidden',
		[mcpIsErrorMarker]: true,
	})

	// Structured-only success stays a plain object (no unsafe content heuristic).
	expect(
		wrapDownstreamMcpToolResult(
			{
				content: [{ type: 'text', text: 'ignored when structured present' }],
				structuredContent: { id: 1 },
			},
			{ kind: 'mcp-server', label: 'linear:get' },
		),
	).toEqual({ id: 1 })
})

test('reserved structuredContent marker names are isolated on every wrap path', () => {
	const collidingStructured = {
		id: 1,
		[mcpContentMarker]: [
			{
				type: 'image',
				data: minimalWebpBase64,
				mimeType: 'image/webp',
			},
		],
		[mcpIsErrorMarker]: true,
		[mcpStructuredContentMarker]: { injected: true },
	}

	// Success: text + structured (plain structured return, no trusted markers).
	const textAndStructured = wrapDownstreamMcpToolResult(
		{
			content: [{ type: 'text', text: 'ok' }],
			structuredContent: collidingStructured,
		},
		{ kind: 'mcp-server', label: 'collision:text' },
	)
	expect(textAndStructured).toEqual({
		id: 1,
		[reservedStructuredFieldCollisionKey]: {
			[mcpContentMarker]: collidingStructured[mcpContentMarker],
			[mcpIsErrorMarker]: true,
			[mcpStructuredContentMarker]: { injected: true },
		},
	})
	expect(extractMcpPassthrough(textAndStructured)).toBeNull()

	// Structured-only success.
	const structuredOnly = wrapDownstreamMcpToolResult(
		{ structuredContent: collidingStructured },
		{ kind: 'remote-connector', label: 'collision:structured' },
	)
	expect(structuredOnly).toEqual(textAndStructured)
	expect(extractMcpPassthrough(structuredOnly)).toBeNull()

	// Error path: real isError marker wins; collisions stay isolated.
	const errorWrapped = wrapDownstreamMcpToolResult(
		{
			content: [{ type: 'text', text: 'denied' }],
			structuredContent: {
				code: 'forbidden',
				[mcpIsErrorMarker]: false,
				[mcpContentMarker]: [{ type: 'text', text: 'spoofed' }],
			},
			isError: true,
		},
		{ kind: 'mcp-server', label: 'collision:error' },
	)
	expect(errorWrapped[mcpIsErrorMarker]).toBe(true)
	expect(errorWrapped[mcpContentMarker]).toEqual([
		{ type: 'text', text: 'denied' },
	])
	expect(errorWrapped[mcpStructuredContentMarker]).toEqual({
		code: 'forbidden',
		[reservedStructuredFieldCollisionKey]: {
			[mcpIsErrorMarker]: false,
			[mcpContentMarker]: [{ type: 'text', text: 'spoofed' }],
		},
	})
	expect(extractMcpPassthrough(errorWrapped)).toEqual({
		content: [{ type: 'text', text: 'denied' }],
		structuredResult: {
			code: 'forbidden',
			[reservedStructuredFieldCollisionKey]: {
				[mcpIsErrorMarker]: false,
				[mcpContentMarker]: [{ type: 'text', text: 'spoofed' }],
			},
		},
		isError: true,
	})

	expect(
		sanitizeStructuredContentRecord({
			ok: true,
			[mcpContentMarker]: [],
		}),
	).toEqual({
		ok: true,
		[reservedStructuredFieldCollisionKey]: {
			[mcpContentMarker]: [],
		},
	})
})

test('untrusted content is bounded by block count and payload size before schema atob', () => {
	const atobSpy = vi.spyOn(globalThis, 'atob')

	const tooManyBlocks = Array.from(
		{ length: maxMcpContentBlockCount + 1 },
		() => ({
			type: 'text' as const,
			text: 'x',
		}),
	)
	expect(() =>
		validateDownstreamMcpContentBlocks(tooManyBlocks, {
			kind: 'mcp-server',
			label: 'flood:blocks',
		}),
	).toThrow(/flood:blocks[\s\S]*too many MCP content blocks/)
	expect(atobSpy).not.toHaveBeenCalled()

	const hugePayload = [
		{
			type: 'image',
			data: oversizedBase64(defaultMcpContentLimitBytes + 80_000),
			mimeType: 'image/webp',
		},
	]
	expect(estimateUntrustedMcpContentPayloadBytes(hugePayload)).toBeGreaterThan(
		defaultMcpContentLimitBytes,
	)
	expect(() =>
		validateDownstreamMcpContentBlocks(hugePayload, {
			kind: 'remote-connector',
			label: 'flood:bytes',
		}),
	).toThrow(/flood:bytes[\s\S]*exceeding content limit/)
	expect(atobSpy).not.toHaveBeenCalled()

	atobSpy.mockRestore()

	const withinCount = Array.from({ length: maxMcpContentBlockCount }, () => ({
		type: 'text' as const,
		text: 'ok',
	}))
	expect(
		validateDownstreamMcpContentBlocks(withinCount, {
			kind: 'execute',
			label: 'default export (__mcpContent)',
		}),
	).toHaveLength(maxMcpContentBlockCount)
})

test('persistence bounds or omits rawContent and strips markers from stored result', () => {
	const webpBlock = {
		type: 'image' as const,
		data: minimalWebpBase64,
		mimeType: 'image/webp',
	}
	const wrapped = wrapDownstreamMcpToolResult(
		{
			content: [webpBlock],
			structuredContent: { shotId: 's1' },
		},
		{ kind: 'mcp-server', label: 'vision:shot' },
	)
	const persisted = persistableExecutionArtifacts(wrapped)
	expect(persisted.result).toEqual({ shotId: 's1' })
	expect(persisted.rawContent).toEqual([webpBlock])
	expect(persisted.rawContentOmitted).toBeNull()

	const huge = [
		{
			type: 'image' as const,
			data: oversizedBase64(defaultMcpContentLimitBytes + 40_000),
			mimeType: 'image/png',
		},
	]
	const omitted = boundRawContentForPersistence(huge)
	expect(omitted.rawContent).toBeNull()
	expect(omitted.rawContentOmitted).toMatchObject({
		blockCount: 1,
		note: expect.stringContaining('exceeding content limit'),
	})

	const oversizeArtifacts = persistableExecutionArtifacts({
		[mcpContentMarker]: huge,
		shotId: 'drop-me-from-markers-path',
	})
	expect(oversizeArtifacts.result).toEqual({
		shotId: 'drop-me-from-markers-path',
	})
	expect(oversizeArtifacts.rawContent).toBeNull()
	expect(oversizeArtifacts.rawContentOmitted?.blockCount).toBe(1)

	expect(persistableExecutionArtifacts({ ok: true })).toEqual({
		result: { ok: true },
		rawContent: null,
		rawContentOmitted: null,
	})
})
