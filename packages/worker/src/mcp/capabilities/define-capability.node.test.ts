import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { defineCapability } from './define-capability.ts'

function createCapabilityContext() {
	return {
		env: {} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
			},
		}),
	}
}

test('Zod capability validation failures identify the capability, fields, and repair path', async () => {
	const inputHandler = vi.fn(async () => ({ package_id: 'github' }))
	const inputCapability = defineCapability({
		name: 'package_get',
		domain: 'packages',
		description: 'Get a package.',
		inputSchema: z.object({ package_id: z.string() }),
		outputSchema: z.object({ package_id: z.string() }),
		handler: inputHandler,
	})

	const inputError = await inputCapability
		.handler({ kody_id: 'github' }, createCapabilityContext())
		.catch((error: unknown) => error)

	expect(inputError).toBeInstanceOf(McpCallerError)
	expect(inputError).toMatchObject({
		message: expect.stringContaining(
			'Invalid input for capability "package_get".',
		),
		cause: expect.any(z.ZodError),
	})
	expect(inputError.message).toContain('package_id')
	expect(inputHandler).not.toHaveBeenCalled()

	const outputHandler = vi.fn(async () => ({ package_id: 123 }) as never)
	const outputCapability = defineCapability({
		name: 'package_save',
		domain: 'packages',
		description: 'Save a package.',
		inputSchema: z.object({ package_id: z.string() }),
		outputSchema: z.object({ package_id: z.string() }),
		handler: outputHandler,
	})

	const outputError = await outputCapability
		.handler({ package_id: 'github' }, createCapabilityContext())
		.catch((error: unknown) => error)

	expect(outputHandler).toHaveBeenCalledOnce()
	expect(outputError).toBeInstanceOf(Error)
	expect(outputError).not.toBeInstanceOf(McpCallerError)
	expect(outputError).toMatchObject({
		message: expect.stringContaining(
			'Capability "package_save" returned an invalid output shape.',
		),
		cause: expect.any(z.ZodError),
	})
	expect(outputError.message).toContain('package_id')
})
