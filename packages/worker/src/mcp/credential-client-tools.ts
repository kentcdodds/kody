/**
 * Host tools behind the sandbox `credential()` client (ADR 0068). They are
 * runtime helpers, not capabilities: they exist only inside a run (or a
 * CapabilityProxy session for CLI `--local`) and return structured errors as
 * values, so the sandbox can rebuild them with `code` and `retryWith`.
 */
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	callToolWithCredentialClient,
	openCredentialClient,
	openCredentialClients,
	refreshCredentialClient,
	signWithCredentialClient,
	toCredentialClientError,
	validateCredentialCallMap,
	type CredentialClientContext,
} from '#worker/credentials/credential-client.ts'
import { credentialClientToolNames } from './execute-modules/credential-client-source.ts'
import {
	type AdditionalKodyTools,
	type CredentialClientToolOptions,
} from './runtime-helper-manifest.ts'

function readArgs(args: unknown): Record<string, unknown> {
	return args && typeof args === 'object' && !Array.isArray(args)
		? (args as Record<string, unknown>)
		: {}
}

async function asResult(run: () => Promise<unknown>) {
	try {
		return { ok: true, value: await run() }
	} catch (error) {
		const structured = toCredentialClientError(error)
		if (!structured) throw error
		return { ok: false, error: structured.body }
	}
}

export function createCredentialClientKodyTools(input: {
	env: Env
	callerContext: McpCallerContext
	options: CredentialClientToolOptions
}): AdditionalKodyTools {
	const context = async (args: Record<string, unknown>) =>
		({
			env: input.env,
			callerContext: input.callerContext,
			binding: input.options.binding,
			packageId: await input.options.resolvePackageId(args.packageId),
			callMap: input.options.callMap ?? null,
			runNeeds: input.options.runNeeds,
			waitUntil: input.options.waitUntil,
		}) satisfies CredentialClientContext
	return {
		[credentialClientToolNames.open]: async (raw) => {
			const args = readArgs(raw)
			return await asResult(async () =>
				openCredentialClient(await context(args), args),
			)
		},
		[credentialClientToolNames.openAll]: async (raw) => {
			const args = readArgs(raw)
			return await asResult(async () =>
				openCredentialClients(await context(args), args),
			)
		},
		[credentialClientToolNames.check]: async (raw) => {
			const args = readArgs(raw)
			return await asResult(async () => {
				const callMap = input.options.callMap ?? null
				if (!callMap) return { warnings: [] }
				const packageId = await input.options.resolvePackageId(args.packageId)
				return await validateCredentialCallMap({
					env: input.env,
					request: input.callerContext.request ?? null,
					map: callMap,
					packageIds: packageId ? [packageId] : [],
					strict: args.strict === true,
				})
			})
		},
		[credentialClientToolNames.sign]: async (raw) => {
			const args = readArgs(raw)
			return await asResult(async () =>
				signWithCredentialClient(await context(args), args),
			)
		},
		[credentialClientToolNames.callTool]: async (raw) => {
			const args = readArgs(raw)
			return await asResult(async () =>
				callToolWithCredentialClient(await context(args), args),
			)
		},
		[credentialClientToolNames.refresh]: async (raw) => {
			const args = readArgs(raw)
			return await asResult(async () =>
				refreshCredentialClient(await context(args), args),
			)
		},
	}
}
