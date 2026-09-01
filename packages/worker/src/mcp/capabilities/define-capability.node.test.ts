import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { defineCapability } from './define-capability.ts'
import { defineDomain } from './define-domain.ts'

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
		name: 'packageGet',
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
			'Invalid input for capability "packageGet".',
		),
		cause: expect.any(z.ZodError),
	})
	expect(inputError.message).toContain('package_id')
	expect(inputHandler).not.toHaveBeenCalled()

	const outputHandler = vi.fn(async () => ({ package_id: 123 }) as never)
	const outputCapability = defineCapability({
		name: 'packageSave',
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
			'Capability "packageSave" returned an invalid output shape.',
		),
		cause: expect.any(z.ZodError),
	})
	expect(outputError.message).toContain('package_id')
})

test('defineCapability rejects snake_case and non-identifier builtin names', () => {
	expect(() =>
		defineCapability({
			name: 'package_get',
			domain: 'packages',
			description: 'Get a package.',
			inputSchema: z.object({}),
			handler: async () => ({}),
		}),
	).toThrow(/camelCase/)

	expect(() =>
		defineCapability({
			name: 'package-get',
			domain: 'packages',
			description: 'Get a package.',
			inputSchema: z.object({}),
			handler: async () => ({}),
		}),
	).toThrow(/JavaScript identifier/)

	const mcpCapability = defineCapability({
		name: 'create_issue',
		domain: 'mcp:linear',
		description: 'Create an issue.',
		source: 'mcp-server',
		inputSchema: z.object({}),
		handler: async () => ({}),
	})
	expect(mcpCapability.name).toBe('create_issue')
})

test('defineDomain rejects snake_case domain ids', () => {
	expect(() =>
		defineDomain({
			name: 'mcp_servers',
			description: 'MCP servers.',
			capabilities: [],
		}),
	).toThrow(/camelCase/)
})
