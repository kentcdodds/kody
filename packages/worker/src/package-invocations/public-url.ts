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
	'If the package invocation token is scoped to allowedSources, include JSON "source" with the exact allowed source label. Otherwise omit "source" or send null.'

function buildPackageInvocationTokenSetupExportName(exportName: string) {
	const normalized = normalizePackageInvocationExportName(exportName)
	return normalized.startsWith('./') ? normalized.slice(2) : normalized
}

export function buildPackageInvocationTokenSetupUrl(input: {
	baseUrl: string
	kodyId: string
	exportName: string
}) {
	const url = new URL('/account/package-invocation-tokens/new', input.baseUrl)
	url.searchParams.set('packageKodyIds', input.kodyId)
	url.searchParams.set(
		'exportNames',
		buildPackageInvocationTokenSetupExportName(input.exportName),
	)
	return url.toString()
}

export function buildExternalPackageInvocationDescriptor(input: {
	baseUrl: string
	ownerUsername: string
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
			kodyId: input.kodyId,
			exportName: normalizedExportName,
		}),
		sourceGuidance,
	}
}
