import {
	type PackageInvokeInput,
	type PackageInvokeNormalizedInput,
} from '#mcp/run-kody-registry.ts'

function readOptionalString(
	input: PackageInvokeInput,
	fieldNames: Array<string>,
) {
	for (const fieldName of fieldNames) {
		const value = input[fieldName]
		if (typeof value === 'string' && value.trim()) return value.trim()
	}
	return null
}

function readSinglePackageIdentifier(
	input: PackageInvokeInput,
	operationName = 'packages.invoke',
) {
	const candidates = [
		{
			kind: 'kodyId' as const,
			value: readOptionalString(input, ['kodyId', 'kody_id']),
		},
		{
			kind: 'packageId' as const,
			value: readOptionalString(input, ['packageId', 'package_id']),
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
	input: PackageInvokeInput,
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

export function parsePackageInvokeInput(
	input: PackageInvokeInput,
	operationName = 'packages.invoke',
) {
	const packageIdentifier = readSinglePackageIdentifier(input, operationName)
	const exportName = readOptionalString(input, ['exportName', 'export_name'])
	if (!exportName) {
		throw new Error(`${operationName} requires exportName.`)
	}
	return {
		packageIdentifier,
		packageIdOrKodyId: packageIdentifier.value,
		exportName,
		params: readPackageInvokeParams(input, operationName),
		idempotencyKey: readOptionalString(input, [
			'idempotencyKey',
			'idempotency_key',
		]),
		topic: readOptionalString(input, ['topic']),
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
		...(input.request.packageIdentifier.kind === 'kodyId'
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
