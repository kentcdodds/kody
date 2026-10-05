import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import * as observability from '#mcp/observability.ts'
import { secretSetCapability } from './secret-set.ts'
import { secretSetManyCapability } from './secret-set-many.ts'

function createCapabilityContext() {
	return {
		env: {} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
			},
		}),
	}
}

async function expectParseInputCallerError(args: {
	capability: typeof secretSetCapability | typeof secretSetManyCapability
	input: Record<string, unknown>
	secretValue?: string
}) {
	const logSpy = vi.spyOn(observability, 'logMcpEvent')
	const error = await args.capability
		.handler(args.input, createCapabilityContext())
		.catch((caught: unknown) => caught)

	const failure = logSpy.mock.calls
		.map(([event]) => event)
		.find(
			(event) =>
				event.capabilityName === args.capability.name &&
				event.outcome === 'failure',
		)
	logSpy.mockRestore()

	expect(error).toBeInstanceOf(McpCallerError)
	expect(error).not.toBeInstanceOf(z.ZodError)
	if (!(error instanceof Error)) {
		throw new Error('Expected capability failure to be an Error')
	}
	expect(error.message).toContain(
		`Invalid input for capability "${args.capability.name}".`,
	)
	expect(error.message).toContain(
		`Repair: Call search({ entity: "capability:${args.capability.name}" }) for the exact input shape.`,
	)
	if (args.secretValue) {
		expect(error.message).not.toContain(args.secretValue)
	}

	expect(failure).toMatchObject({
		failurePhase: 'parse_input',
		errorName: 'McpCallerError',
	})
}

test('secretSet invalid input fails in parse_input as McpCallerError (KODY-8T)', async () => {
	const secretValue = 'hunter2-should-never-echo'
	await expectParseInputCallerError({
		capability: secretSetCapability,
		input: { name: 'api-key', scope: 'not-a-scope', value: secretValue },
		secretValue,
	})
})

test('secretSetMany invalid input fails in parse_input as McpCallerError', async () => {
	const secretValue = 'hunter2-batch-should-never-echo'
	await expectParseInputCallerError({
		capability: secretSetManyCapability,
		input: {
			secrets: [{ name: 'api-key', scope: 'not-a-scope', value: secretValue }],
		},
		secretValue,
	})
})

test('JSON-schema inputSchema skips wrapper Zod parse and would leak handler ZodError', async () => {
	// Documents the KODY-8T failure mode: z.toJSONSchema(...) as inputSchema
	// makes createSchemaParser a no-op, so a handler-side .parse throws a raw
	// ZodError during failurePhase "handler" instead of McpCallerError at
	// parse_input. secretSet/secretSetMany used to do this.
	const { defineCapability } = await import('../define-capability.ts')
	const schema = z.object({ name: z.string().min(1) })
	const leaky = defineCapability({
		name: 'leakProbe',
		domain: 'secrets',
		description: 'Probe JSON-schema bypass.',
		inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
		handler: async (args) => {
			schema.parse(args)
			return {}
		},
	})

	const logSpy = vi.spyOn(observability, 'logMcpEvent')
	const error = await leaky
		.handler({}, createCapabilityContext())
		.catch((caught: unknown) => caught)
	const failure = logSpy.mock.calls
		.map(([event]) => event)
		.find(
			(event) =>
				event.capabilityName === 'leakProbe' && event.outcome === 'failure',
		)
	logSpy.mockRestore()

	expect(error).toBeInstanceOf(z.ZodError)
	expect(error).not.toBeInstanceOf(McpCallerError)
	expect(failure).toMatchObject({
		failurePhase: 'handler',
		errorName: 'ZodError',
	})
})
