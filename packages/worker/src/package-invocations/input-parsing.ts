import {
	type PackageInvokeInput,
	type PackageInvokeNormalizedInput,
} from '#mcp/run-kody-registry.ts'
import {
	packageSpecifierPrefix,
	parseKodyPackageSpecifier,
} from '#worker/package-runtime/package-import-resolution.ts'

const legacyPackageInvokeInputKeys = [
	'kodyId',
	'packageId',
	'exportName',
	'params',
	'idempotencyKey',
	'topic',
] as const
const packageInvokeOptionKeys = [
	'exportName',
	'params',
	'idempotencyKey',
	'topic',
] as const
const packageInvokeEnvelopeKeys = ['specifier', 'options'] as const

function assertRecord(
	value: unknown,
	message: string,
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(message)
	}
}

function assertKnownKeys(
	input: Record<string, unknown>,
	acceptedKeys: ReadonlyArray<string>,
	operationName: string,
) {
	const acceptedKeySet = new Set(acceptedKeys)
	const unknownKeys = Object.keys(input).filter(
		(key) => !acceptedKeySet.has(key),
	)
	if (unknownKeys.length === 0) return
	throw new Error(
		`${operationName} received unknown input ${unknownKeys.length === 1 ? 'key' : 'keys'} ${unknownKeys.map((key) => JSON.stringify(key)).join(', ')}. Accepted keys: ${acceptedKeys.join(', ')}.`,
	)
}

function readOptionalString(input: Record<string, unknown>, fieldName: string) {
	const value = input[fieldName]
	if (typeof value === 'string' && value.trim()) return value.trim()
	return null
}

function readLegacyPackageIdentifier(
	input: Record<string, unknown>,
	operationName = 'packages.invoke',
) {
	const candidates = [
		{
			kind: 'kodyId' as const,
			value: readOptionalString(input, 'kodyId'),
		},
		{
			kind: 'packageId' as const,
			value: readOptionalString(input, 'packageId'),
		},
	].filter(
		(candidate): candidate is { kind: 'kodyId' | 'packageId'; value: string } =>
			candidate.value !== null,
	)
	const unique = Array.from(
		new Set(candidates.map((candidate) => candidate.value)),
	)
	if (unique.length > 1) {
		throw new Error(
			`${operationName} accepts one package identifier. Use kodyId unless you need the saved package id.`,
		)
	}
	const [identifier] = candidates
	if (!identifier) {
		throw new Error(`${operationName} requires kodyId or packageId.`)
	}
	return identifier
}

function readPackageInvokeParams(
	input: Record<string, unknown>,
	operationName = 'packages.invoke',
) {
	const params = input['params']
	if (params === undefined || params === null) return undefined
	if (!params || typeof params !== 'object' || Array.isArray(params)) {
		throw new Error(
			`${operationName} params must be a JSON object when provided.`,
		)
	}
	return params as Record<string, unknown>
}

function parsePackageInvokeSpecifier(
	specifierValue: unknown,
	operationName: string,
) {
	if (typeof specifierValue !== 'string' || !specifierValue.trim()) {
		throw new Error(
			`${operationName} requires a kody:@username/kodyid specifier.`,
		)
	}
	const trimmed = specifierValue.trim()
	const specifier = trimmed.startsWith('@') ? `kody:${trimmed}` : trimmed
	const parsed = parseKodyPackageSpecifier(specifier)
	const pathSegments = specifier.slice(packageSpecifierPrefix.length).split('/')
	const specifierExportName = pathSegments
		.slice(2)
		.some((segment) => segment.trim())
		? parsed.exportName
		: null
	return {
		specifier,
		packageName: parsed.packageName,
		specifierExportName,
	}
}

export function parsePackageInvokeInput(
	input: PackageInvokeInput,
	operationName = 'packages.invoke',
) {
	assertRecord(input, `${operationName} requires an input object.`)
	if ('specifier' in input || 'options' in input) {
		assertKnownKeys(input, packageInvokeEnvelopeKeys, operationName)
		const parsedSpecifier = parsePackageInvokeSpecifier(
			input['specifier'],
			operationName,
		)
		const rawOptions = input['options']
		if (rawOptions !== undefined && rawOptions !== null) {
			assertRecord(
				rawOptions,
				`${operationName} options must be an object when provided.`,
			)
		}
		const options = rawOptions ?? {}
		assertKnownKeys(options, packageInvokeOptionKeys, operationName)
		const exportName =
			parsedSpecifier.specifierExportName ??
			readOptionalString(options, 'exportName')
		if (!exportName) {
			throw new Error(
				`${operationName} requires exportName when the package specifier has no export subpath.`,
			)
		}
		return {
			packageIdentifier: {
				kind: 'specifier' as const,
				value: parsedSpecifier.specifier,
				packageName: parsedSpecifier.packageName,
			},
			packageIdOrKodyId: parsedSpecifier.packageName,
			exportName,
			params: readPackageInvokeParams(options, operationName),
			idempotencyKey: readOptionalString(options, 'idempotencyKey'),
			topic: readOptionalString(options, 'topic'),
		}
	}

	assertKnownKeys(input, legacyPackageInvokeInputKeys, operationName)
	const packageIdentifier = readLegacyPackageIdentifier(input, operationName)
	const exportName = readOptionalString(input, 'exportName')
	if (!exportName) {
		throw new Error(`${operationName} requires exportName.`)
	}
	return {
		packageIdentifier,
		packageIdOrKodyId: packageIdentifier.value,
		exportName,
		params: readPackageInvokeParams(input, operationName),
		idempotencyKey: readOptionalString(input, 'idempotencyKey'),
		topic: readOptionalString(input, 'topic'),
	}
}

export type ParsedPackageInvokeInput = ReturnType<
	typeof parsePackageInvokeInput
>

export function buildNormalizedPackageInvokeInput(input: {
	request: ParsedPackageInvokeInput
	exportName: string
}): PackageInvokeNormalizedInput {
	return {
		...(input.request.packageIdentifier.kind === 'specifier'
			? { specifier: input.request.packageIdentifier.value }
			: input.request.packageIdentifier.kind === 'kodyId'
				? { kodyId: input.request.packageIdentifier.value }
				: { packageId: input.request.packageIdentifier.value }),
		exportName: input.exportName,
		...(input.request.params === undefined
			? {}
			: { params: input.request.params }),
		...(input.request.idempotencyKey
			? { idempotencyKey: input.request.idempotencyKey }
			: {}),
		...(input.request.topic ? { topic: input.request.topic } : {}),
	}
}
