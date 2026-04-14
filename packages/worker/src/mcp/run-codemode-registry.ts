import {
	resolveProvider,
	type ExecuteResult,
	type ResolvedProvider,
	type ToolProvider,
} from '@cloudflare/codemode'
import { exports as workerExports } from 'cloudflare:workers'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	getAdditionalPropertiesSchema,
	getArrayItemSchema,
	getSchemaProperties,
	isRecord,
	isSecretInputSchema,
	resolveCapabilityInputSecrets,
} from '#mcp/secrets/capability-inputs.ts'
import {
	capabilityInputSecretAuthRequiredMessage,
	createCapabilitySecretAccessDeniedMessage,
	createCapabilitySecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
} from '#mcp/secrets/errors.ts'
import { buildSecretCapabilityApprovalUrl } from '#mcp/secrets/capability-approval-url.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { type ReferencedSecret } from '#mcp/secrets/placeholders.ts'
import { buildParameterizedSkillCode } from '#mcp/skills/skill-parameters.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { createExecuteHelperPrelude } from '#mcp/execute-modules/codemode-utils.ts'

type AdditionalCodemodeTools = Record<
	string,
	(args: unknown) => Promise<unknown>
>

export async function buildCodemodeFns(
	env: Env,
	callerContext: McpCallerContext,
	options?: {
		resolveSecretValue?: (
			secret: ReferencedSecret,
			capabilityName: string,
		) => Promise<string>
		trackSecretInputValue?: (value: string) => void
		additionalTools?: AdditionalCodemodeTools
	},
) {
	const { capabilityMap } = await getCapabilityRegistryForContext({
		env,
		callerContext,
	})
	const additionalTools = options?.additionalTools ?? {}
	for (const name of Object.keys(additionalTools)) {
		if (capabilityMap[name]) {
			throw new Error(`Codemode helper "${name}" collides with a capability.`)
		}
	}
	return {
		...Object.fromEntries(
		Object.values(capabilityMap).map((capability) => [
			capability.name,
			async (args: unknown) => {
				const resolveSecretValue =
					options?.resolveSecretValue ??
					createCapabilityInputSecretResolver(
						env,
						callerContext,
						capability.name,
					)
				const resolvedArgs = await resolveCapabilityInputSecrets({
					schema: capability.inputSchema,
					value: (args ?? {}) as Record<string, unknown>,
					resolveSecretValue: (secret) =>
						resolveSecretValue(secret, capability.name),
				})
				collectSecretInputValues({
					schema: capability.inputSchema,
					value: resolvedArgs,
					track: options?.trackSecretInputValue,
				})
				return capability.handler(resolvedArgs as Record<string, unknown>, {
					env,
					callerContext,
				})
			},
		]),
		),
		...additionalTools,
	}
}

export async function buildCodemodeProvider(
	env: Env,
	callerContext: McpCallerContext,
	options?: {
		trackSecretInputValue?: (value: string) => void
		additionalTools?: AdditionalCodemodeTools
	},
): Promise<ResolvedProvider> {
	const tools = await buildCodemodeFns(env, callerContext, options)
	const provider: ToolProvider = {
		name: 'codemode',
		tools: Object.fromEntries(
			Object.entries(tools).map(([name, execute]) => [
				name,
				{
					execute,
				},
			]),
		),
	}
	return resolveProvider(provider)
}

function createCapabilityInputSecretResolver(
	env: Env,
	callerContext: McpCallerContext,
	capabilityName: string,
) {
	return async (secret: ReferencedSecret, _currentCapabilityName: string) => {
		const userId = callerContext.user?.userId ?? null
		if (!userId) {
			throw new Error(capabilityInputSecretAuthRequiredMessage)
		}
		const normalizedStorageContext = normalizeStorageContext(
			callerContext.storageContext ?? null,
		)
		const resolved = await resolveSecret({
			env,
			userId,
			name: secret.name,
			scope: secret.scope,
			storageContext: normalizedStorageContext,
		})
		if (!resolved.found || typeof resolved.value !== 'string') {
			throw new Error(createMissingSecretMessage(secret.name))
		}
		if (!resolved.allowedCapabilities.includes(capabilityName)) {
			const approvalUrl = buildSecretCapabilityApprovalUrl({
				baseUrl: callerContext.baseUrl,
				name: secret.name,
				scope: resolved.scope ?? secret.scope ?? 'user',
				capabilityName,
				storageContext: normalizedStorageContext,
			})
			throw new Error(
				createCapabilitySecretAccessDeniedMessage(
					secret.name,
					capabilityName,
					approvalUrl,
				),
			)
		}
		return resolved.value
	}
}

export async function runCodemodeWithRegistry(
	env: Env,
	callerContext: McpCallerContext,
	code: string,
	params?: Record<string, unknown>,
	options?: {
		executorExports?: typeof workerExports
		additionalTools?: AdditionalCodemodeTools
		helperPrelude?: string
	},
): Promise<ExecuteResult> {
	const { createExecuteExecutor } = await import('#mcp/executor.ts')
	const { normalizeCode } = await import('@cloudflare/codemode')
	const secretRedactor = createExecutionSecretRedactor()
	const normalizedStorageContext = normalizeStorageContext(
		callerContext.storageContext ?? null,
	)
	const executor = createExecuteExecutor({
		env,
		exports: options?.executorExports ?? workerExports,
		gatewayProps: {
			baseUrl: callerContext.baseUrl,
			userId: callerContext.user?.userId ?? null,
			storageContext: normalizedStorageContext,
		},
	})
	const provider = await buildCodemodeProvider(env, callerContext, {
		trackSecretInputValue: (value) => {
			secretRedactor.track(value)
		},
		additionalTools: options?.additionalTools,
	})
	const wrappedCode =
		params !== undefined
			? await buildParameterizedSkillCode(code, params)
			: code
	const normalized = normalizeCode(wrappedCode)
	const wrapped = `async () => {
${createExecuteHelperPrelude()}
${options?.helperPrelude ? `${options.helperPrelude}\n` : ''}
  const __kodyUserCode = (${normalized});
  return await __kodyUserCode();
}`
	const result = await executor.execute(wrapped, [provider])
	const sanitizedResult = secretRedactor.sanitizeExecuteResult(result)
	if (!result.error) return sanitizedResult
	const batchMessage = await rewriteCapabilitySecretError({
		error: result.error,
		env,
		callerContext,
	})
	if (!batchMessage) return sanitizedResult
	return {
		...sanitizedResult,
		error: secretRedactor.redactErrorMessage(batchMessage),
	}
}
async function rewriteCapabilitySecretError(input: {
	error: unknown
	env: Env
	callerContext: McpCallerContext
}) {
	const message =
		input.error instanceof Error ? input.error.message : String(input.error)
	const capabilityMatch = message.match(
		/^Secret "([^"]+)" is not allowed for capability "([^"]+)"/,
	)
	if (!capabilityMatch?.[1] || !capabilityMatch?.[2]) return null
	const capabilityName = capabilityMatch[2]
	const userId = input.callerContext.user?.userId ?? null
	if (!userId) return null
	// Only use the structured error message. Scanning the full wrapped execute
	// bundle (prelude + user code) via /Secret "…"/ false-positives on unrelated
	// string literals, comments, or prior-step text and inflates approval lists.
	const secretNames = collectSecretNamesFromCapabilityError(input.error)
	if (secretNames.length === 0) return null
	const normalizedStorageContext = normalizeStorageContext(
		input.callerContext.storageContext,
	)
	const missing = await findMissingCapabilityApprovals({
		env: input.env,
		userId,
		secretNames,
		capabilityName,
		storageContext: normalizedStorageContext,
		baseUrl: input.callerContext.baseUrl,
	})
	if (missing.length === 0) return null
	return createCapabilitySecretAccessDeniedBatchMessage(missing)
}

function collectSecretNamesFromCapabilityError(error: unknown) {
	const message =
		error instanceof Error
			? error.message
			: typeof error === 'string'
				? error
				: ''
	const fromError = message ? parseSecretNamesFromMessage(message) : []
	return normalizeSecretNameList(fromError)
}

function parseSecretNamesFromMessage(message: string) {
	const matches = Array.from(message.matchAll(/Secret "([^"]+)"/g))
	return matches
		.map((match) => match[1])
		.filter((value): value is string => Boolean(value))
}

function normalizeSecretNameList(names: Array<string>) {
	return Array.from(
		new Set(names.map((name) => name.trim()).filter((name) => name.length > 0)),
	).sort((left, right) => left.localeCompare(right))
}

const redactedSecretText = '[REDACTED SECRET]'

function createExecutionSecretRedactor() {
	const secretValues = new Set<string>()
	return {
		track(value: string) {
			if (value.length > 0) {
				secretValues.add(value)
			}
		},
		redactErrorMessage(value: string) {
			return redactSecretValuesInString(value, secretValues)
		},
		sanitizeExecuteResult(result: ExecuteResult): ExecuteResult {
			return {
				...result,
				result: redactUnknownSecretValues(result.result, secretValues),
				logs: Array.isArray(result.logs)
					? result.logs.map((entry) =>
							redactSecretValuesInString(entry, secretValues),
						)
					: result.logs,
				error: redactExecuteError(result.error, secretValues),
			}
		},
	}
}

function collectSecretInputValues(input: {
	schema: unknown
	value: unknown
	track?: (value: string) => void
}) {
	if (!input.track) return
	visitSecretInputValue(input.schema, input.value, input.track)
}

function visitSecretInputValue(
	schema: unknown,
	value: unknown,
	track: (value: string) => void,
) {
	if (typeof value === 'string' && isSecretInputSchema(schema)) {
		track(value)
		return
	}
	if (Array.isArray(value)) {
		const itemSchema = getArrayItemSchema(schema)
		if (!itemSchema) return
		for (const item of value) {
			visitSecretInputValue(itemSchema, item, track)
		}
		return
	}
	if (!isRecord(value)) return
	const propertySchemas = getSchemaProperties(schema)
	const additionalProperties = getAdditionalPropertiesSchema(schema)
	if (!propertySchemas && !additionalProperties) return
	for (const [key, entryValue] of Object.entries(value)) {
		const entrySchema = propertySchemas?.[key] ?? additionalProperties
		if (!entrySchema) continue
		visitSecretInputValue(entrySchema, entryValue, track)
	}
}

function redactUnknownSecretValues(
	value: unknown,
	secretValues: ReadonlySet<string>,
	seen = new WeakMap<object, unknown>(),
): unknown {
	if (secretValues.size === 0) return value
	if (typeof value === 'string') {
		return redactSecretValuesInString(value, secretValues)
	}
	if (value instanceof Error) {
		const existing = seen.get(value)
		if (existing) return existing
		const next = new Error(
			redactSecretValuesInString(value.message, secretValues),
			value.cause !== undefined ? { cause: undefined } : undefined,
		)
		seen.set(value, next)
		if (value.cause !== undefined) {
			next.cause = redactUnknownSecretValues(value.cause, secretValues, seen)
		}
		next.name = value.name
		if (value.stack) {
			next.stack = redactSecretValuesInString(value.stack, secretValues)
		}
		return next
	}
	if (Array.isArray(value)) {
		const existing = seen.get(value)
		if (existing) return existing
		const next: Array<unknown> = []
		seen.set(value, next)
		for (const entry of value) {
			next.push(redactUnknownSecretValues(entry, secretValues, seen))
		}
		return next
	}
	if (isRecord(value)) {
		const existing = seen.get(value)
		if (existing) return existing
		const next: Record<string, unknown> = {}
		seen.set(value, next)
		for (const [key, entry] of Object.entries(value)) {
			const redactedKey = redactSecretValuesInString(key, secretValues)
			next[redactedKey] = redactUnknownSecretValues(entry, secretValues, seen)
		}
		return next
	}
	return value
}

function redactExecuteError(
	error: ExecuteResult['error'],
	secretValues: ReadonlySet<string>,
): ExecuteResult['error'] {
	if (error === undefined) return undefined
	const redacted = redactUnknownSecretValues(error, secretValues)
	if (typeof redacted === 'string') return redacted
	if (redacted instanceof Error) return redacted.message
	return String(redacted)
}

function redactSecretValuesInString(
	value: string,
	secretValues: ReadonlySet<string>,
) {
	if (secretValues.size === 0 || value.length === 0) return value
	let nextValue = value
	for (const secretValue of [...secretValues].sort(
		(left, right) => right.length - left.length,
	)) {
		nextValue = nextValue.replaceAll(secretValue, redactedSecretText)
	}
	return nextValue
}

function normalizeStorageContext(
	storageContext: McpCallerContext['storageContext'] | null,
) {
	if (!storageContext) return null
	return {
		sessionId: storageContext.sessionId ?? null,
		appId: storageContext.appId ?? null,
	}
}

async function findMissingCapabilityApprovals(input: {
	env: Env
	userId: string
	secretNames: Array<string>
	capabilityName: string
	storageContext: McpCallerContext['storageContext'] | null
	baseUrl: string
}) {
	const normalizedStorageContext = normalizeStorageContext(input.storageContext)
	const entries = await Promise.all(
		input.secretNames.map(async (name) => {
			const resolved = await resolveSecret({
				env: input.env,
				userId: input.userId,
				name,
				storageContext: normalizedStorageContext,
			})
			if (!resolved.found) return null
			if (resolved.allowedCapabilities.includes(input.capabilityName)) {
				return null
			}
			const approvalUrl = buildSecretCapabilityApprovalUrl({
				baseUrl: input.baseUrl,
				name,
				scope: resolved.scope ?? 'user',
				capabilityName: input.capabilityName,
				storageContext: normalizedStorageContext,
			})
			return {
				secretName: name,
				capabilityName: input.capabilityName,
				approvalUrl,
			}
		}),
	)
	return entries.filter(
		(entry): entry is NonNullable<typeof entry> => entry != null,
	)
}
