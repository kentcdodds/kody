import type * as MemoryService from '#mcp/memory/service.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	upsertMemory: vi.fn(),
}))

vi.mock('#mcp/memory/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MemoryService>()
	return {
		...actual,
		upsertMemory: (...args: Array<unknown>) => mockModule.upsertMemory(...args),
	}
})

const {
	memoryDetailsMaxLength,
	memorySubjectMaxLength,
	memorySummaryMaxLength,
} = await import('./meta-memory-shared.ts')
const { metaMemoryUpsertCapability } = await import('./meta-memory-upsert.ts')
const { metaMemoryVerifyCapability } = await import('./meta-memory-verify.ts')

function createSignedInCapabilityContext() {
	return {
		env: {} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-123', email: 'user@example.com' },
		}),
	}
}

const validMemoryFields = {
	subject: 'Preferred editor theme',
	summary: 'User prefers a dark editor theme.',
} as const

async function expectOversizeFieldError(options: {
	capability:
		| typeof metaMemoryVerifyCapability
		| typeof metaMemoryUpsertCapability
	args: Record<string, unknown>
	field: 'subject' | 'summary' | 'details'
	maxLength: number
	actualLength: number
}) {
	const error = await options.capability
		.handler(options.args, createSignedInCapabilityContext())
		.catch((caught: unknown) => caught)

	expect(error).toBeInstanceOf(McpCallerError)
	expect(error).toMatchObject({
		message: expect.stringContaining(
			`Invalid input for capability "${options.capability.name}".`,
		),
	})
	expect((error as Error).message).toContain(
		`${options.field} must be at most ${String(options.maxLength)} characters, got ${String(options.actualLength)}`,
	)
}

test('metaMemoryVerify rejects oversize subject, summary, and details with limit and actual length', async () => {
	const subjectLength = memorySubjectMaxLength + 1
	const summaryLength = memorySummaryMaxLength + 1
	const detailsLength = memoryDetailsMaxLength + 1

	await expectOversizeFieldError({
		capability: metaMemoryVerifyCapability,
		args: {
			...validMemoryFields,
			subject: 'x'.repeat(subjectLength),
		},
		field: 'subject',
		maxLength: memorySubjectMaxLength,
		actualLength: subjectLength,
	})

	await expectOversizeFieldError({
		capability: metaMemoryVerifyCapability,
		args: {
			...validMemoryFields,
			summary: 'y'.repeat(summaryLength),
		},
		field: 'summary',
		maxLength: memorySummaryMaxLength,
		actualLength: summaryLength,
	})

	await expectOversizeFieldError({
		capability: metaMemoryVerifyCapability,
		args: {
			...validMemoryFields,
			details: 'z'.repeat(detailsLength),
		},
		field: 'details',
		maxLength: memoryDetailsMaxLength,
		actualLength: detailsLength,
	})
})

test('metaMemoryUpsert rejects oversize subject, summary, and details with limit and actual length', async () => {
	const subjectLength = memorySubjectMaxLength + 1
	const summaryLength = memorySummaryMaxLength + 1
	const detailsLength = memoryDetailsMaxLength + 1
	const upsertBase = {
		...validMemoryFields,
		verified_by_agent: true,
	}

	await expectOversizeFieldError({
		capability: metaMemoryUpsertCapability,
		args: {
			...upsertBase,
			subject: 'x'.repeat(subjectLength),
		},
		field: 'subject',
		maxLength: memorySubjectMaxLength,
		actualLength: subjectLength,
	})

	await expectOversizeFieldError({
		capability: metaMemoryUpsertCapability,
		args: {
			...upsertBase,
			summary: 'y'.repeat(summaryLength),
		},
		field: 'summary',
		maxLength: memorySummaryMaxLength,
		actualLength: summaryLength,
	})

	await expectOversizeFieldError({
		capability: metaMemoryUpsertCapability,
		args: {
			...upsertBase,
			details: 'z'.repeat(detailsLength),
		},
		field: 'details',
		maxLength: memoryDetailsMaxLength,
		actualLength: detailsLength,
	})
})

test('metaMemoryUpsert still accepts empty optional category and dedupe_key', async () => {
	mockModule.upsertMemory.mockReset()
	mockModule.upsertMemory.mockResolvedValueOnce({
		mode: 'created',
		memory: {
			id: 'memory-1',
			category: null,
			status: 'active',
			subject: validMemoryFields.subject,
			summary: validMemoryFields.summary,
			details: '',
			tags: [],
			sourceUris: [],
			dedupeKey: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			lastAccessedAt: null,
			deletedAt: null,
		},
		warnings: [],
	})

	const result = await metaMemoryUpsertCapability.handler(
		{
			...validMemoryFields,
			category: '',
			dedupe_key: '',
			verified_by_agent: true,
		},
		createSignedInCapabilityContext(),
	)

	expect(mockModule.upsertMemory).toHaveBeenCalledWith(
		expect.objectContaining({
			category: '',
			dedupeKey: '',
		}),
	)
	expect(result).toMatchObject({
		mode: 'created',
		memory: { id: 'memory-1', category: null, dedupe_key: null },
	})
})

test('metaMemoryVerify and metaMemoryUpsert capability types document field max lengths', () => {
	for (const capability of [
		metaMemoryVerifyCapability,
		metaMemoryUpsertCapability,
	]) {
		const subjectSchema = capability.inputSchema.properties?.subject
		const summarySchema = capability.inputSchema.properties?.summary
		const detailsSchema = capability.inputSchema.properties?.details

		expect(subjectSchema).toMatchObject({
			type: 'string',
			maxLength: memorySubjectMaxLength,
		})
		expect(summarySchema).toMatchObject({
			type: 'string',
			maxLength: memorySummaryMaxLength,
		})
		expect(detailsSchema).toMatchObject({
			type: 'string',
			maxLength: memoryDetailsMaxLength,
		})

		expect(capability.inputTypeDefinition).toContain(
			`max ${String(memorySubjectMaxLength)} characters`,
		)
		expect(capability.inputTypeDefinition).toContain(
			`max ${String(memorySummaryMaxLength)} characters`,
		)
		expect(capability.inputTypeDefinition).toContain(
			`max ${String(memoryDetailsMaxLength)} characters`,
		)
	}
})
