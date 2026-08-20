import { readTrimmedParam } from '#client/url-params.ts'

const newSecretPath = '/account/secrets/new'

const newSecretQueryKeys = [
	'name',
	'description',
	'scope',
	'packageId',
	'allowedHosts',
	'allowed-host',
	'allowedCapabilities',
	'capability',
	'allowedPackages',
	'package_id',
	'package',
]

export function getNewSecretQueryKey(href: string) {
	const url = new URL(href, 'http://localhost')
	if (url.pathname !== newSecretPath) return ''
	return newSecretQueryKeys
		.map((key) => `${key}=${url.searchParams.getAll(key).join('\u0000')}`)
		.join('&')
}

export function getNewSecretValueAutofocusKey(href: string) {
	const queryKey = getNewSecretQueryKey(href)
	if (!queryKey) return ''
	const name = readTrimmedParam(
		new URL(href, 'http://localhost').searchParams,
		'name',
	)
	return name ? queryKey : ''
}
