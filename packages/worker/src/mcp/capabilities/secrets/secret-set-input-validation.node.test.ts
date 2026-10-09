import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
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
				userId: personIdFromStored('user-1'),
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
