import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	applyTrustedPackageAppDispatch,
	createPackageCodeRequest,
} from '#worker/package-runtime/package-app-serve.ts'
import {
	buildPackageAppNotFoundMessage,
	buildUnmatchedPackageAppOriginPathMessage,
	isPackageAppSyntheticRequest,
	packageAppSyntheticHeaderName,
	packageAppSyntheticHeaderValue,
} from '#worker/package-runtime/package-app-synthetic.ts'

test('createPackageCodeRequest strips Kody-Synthetic from real inbound traffic', () => {
	const inbound = createPackageCodeRequest(
		new Request('https://apps.example.com/@kody/packages/demo/api', {
			headers: {
				[packageAppSyntheticHeaderName]: packageAppSyntheticHeaderValue,
				'X-Kody-Connector-Session-Key': 'internal',
				Cookie: 'kody_session=owner',
			},
		}),
	)

	expect(inbound.headers.get(packageAppSyntheticHeaderName)).toBeNull()
	expect(inbound.headers.get('X-Kody-Connector-Session-Key')).toBeNull()
	expect(inbound.headers.get('Cookie')).toBeNull()
	expect(isPackageAppSyntheticRequest(inbound)).toBe(false)
})

test('trusted synthetic dispatch exposes Kody-Synthetic only after platform opt-in', () => {
	const inbound = new Request(
		'https://apps.example.com/@kody/packages/demo/probe',
		{
			headers: {
				[packageAppSyntheticHeaderName]: packageAppSyntheticHeaderValue,
			},
		},
	)

	const stripped = createPackageCodeRequest(
		inbound,
		'https://apps.example.com/probe',
	)
	expect(isPackageAppSyntheticRequest(stripped)).toBe(false)

	const trusted = applyTrustedPackageAppDispatch(stripped, { synthetic: true })
	expect(isPackageAppSyntheticRequest(trusted)).toBe(true)
	expect(
		isPackageAppSyntheticRequest(
			applyTrustedPackageAppDispatch(stripped, undefined),
		),
	).toBe(false)
})

test('generated package app worker records synthetic=true in app_fetch run metadata', () => {
	const source = readFileSync(
		fileURLToPath(new URL('./package-app.ts', import.meta.url)),
		'utf8',
	)
	expect(source).toContain('function isSyntheticPackageAppRequest(request)')
	expect(source).toContain(
		'...(isSyntheticPackageAppRequest(request) ? { synthetic: true } : {}),',
	)
})

test('package app diagnostics mention package_app_fetch for origin 404s', () => {
	expect(buildPackageAppNotFoundMessage()).toContain('package_app_fetch')
	expect(buildUnmatchedPackageAppOriginPathMessage()).toContain(
		'package_app_fetch',
	)
})
