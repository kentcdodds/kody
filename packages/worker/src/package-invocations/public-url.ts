import {
	buildPackageInvocationPath,
	buildPackageInvocationRouteExportName,
	buildPackageInvocationUrl,
	normalizePackageInvocationExportName,
} from '@kody-internal/shared/public-urls.ts'

export type ExternalPackageInvocationDescriptor = {
	method: 'POST'
	url: string
	path: string
	ownerUsername: string
	kodyId: string
	routeExportName: string
	normalizedExportName: string
	tokenSetupUrl: string
	sourceGuidance: string
}

const sourceGuidance =
	'JSON "source" is an optional caller label for logs. It does not gate authentication or determine idempotency.'

function buildPackageInvocationTokenSetupExportName(exportName: string) {
	const normalized = normalizePackageInvocationExportName(exportName)
	return normalized.startsWith('./') ? normalized.slice(2) : normalized
}

export function buildPackageInvocationTokenSetupUrl(input: {
	baseUrl: string
	packageId: string
	exportName: string
}) {
	const url = new URL(
		`/account/packages/${encodeURIComponent(input.packageId)}`,
		input.baseUrl,
	)
	url.searchParams.set('newToken', '1')
	url.searchParams.set(
		'exportNames',
		buildPackageInvocationTokenSetupExportName(input.exportName),
	)
	return url.toString()
}

export function buildExternalPackageInvocationDescriptor(input: {
	baseUrl: string
	ownerUsername: string
	packageId: string
	kodyId: string
	exportName: string
}): ExternalPackageInvocationDescriptor {
	const normalizedExportName = normalizePackageInvocationExportName(
		input.exportName,
	)
	const routeExportName =
		buildPackageInvocationRouteExportName(normalizedExportName)
	return {
		method: 'POST',
		url: buildPackageInvocationUrl({
			origin: input.baseUrl,
			username: input.ownerUsername,
			kodyId: input.kodyId,
			exportName: normalizedExportName,
		}),
		path: buildPackageInvocationPath({
			username: input.ownerUsername,
			kodyId: input.kodyId,
			exportName: normalizedExportName,
		}),
		ownerUsername: input.ownerUsername,
		kodyId: input.kodyId,
		routeExportName,
		normalizedExportName,
		tokenSetupUrl: buildPackageInvocationTokenSetupUrl({
			baseUrl: input.baseUrl,
			packageId: input.packageId,
			exportName: normalizedExportName,
		}),
		sourceGuidance,
	}
}
