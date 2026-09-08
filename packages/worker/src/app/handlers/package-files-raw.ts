import { type Action } from 'remix/router'
import { anonymousPersonalizedJsonCacheHeaders } from '#app/anonymous-html-cache.ts'
import {
	loadAccessiblePackageFileRaw,
	loadCommunityPackageFileRaw,
	type PackageFileRawResult,
} from '#app/package-files-data.ts'
import { normalizePackageFilesPath } from '#universal/package-files.ts'
import { type routes } from '#universal/routes.ts'

const rawMediaCsp = "default-src 'none'; sandbox"

function rawNotFound() {
	return new Response('Not found', {
		status: 404,
		headers: {
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
		},
	})
}

function rawUnauthorized() {
	return new Response('Unauthorized', {
		status: 401,
		headers: {
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
		},
	})
}

function rawTooLarge() {
	return new Response('File too large to preview', {
		status: 413,
		headers: {
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
		},
	})
}

function rawMediaResponse(input: {
	request: Request
	result: Extract<PackageFileRawResult, { kind: 'ok' }>
}) {
	if (
		input.result.contentType === 'text/html' ||
		input.result.contentType === 'application/javascript' ||
		input.result.contentType === 'text/javascript' ||
		input.result.contentType === 'text/css'
	) {
		return rawNotFound()
	}
	const cache = anonymousPersonalizedJsonCacheHeaders({
		personalized: false,
		request: input.request,
		visibilityGated: true,
	})
	const headers = new Headers(cache)
	if (input.result.isPrivate) {
		headers.set('Cache-Control', 'private, no-store')
	}
	headers.set('Content-Type', input.result.contentType)
	headers.set(
		'Content-Disposition',
		`inline; filename="${input.result.filename}"`,
	)
	headers.set('Content-Length', String(input.result.bytes.byteLength))
	headers.set('X-Content-Type-Options', 'nosniff')
	headers.set('Content-Security-Policy', rawMediaCsp)
	if (input.request.method === 'HEAD') {
		return new Response(null, { headers })
	}
	const body = new Uint8Array(input.result.bytes.byteLength)
	body.set(input.result.bytes)
	return new Response(body.buffer, { headers })
}

function respondRaw(input: { request: Request; result: PackageFileRawResult }) {
	switch (input.result.kind) {
		case 'ok':
			return rawMediaResponse({
				request: input.request,
				result: input.result,
			})
		case 'unauthorized':
			return rawUnauthorized()
		case 'too-large':
			return rawTooLarge()
		case 'not-found':
		case 'not-media':
			return rawNotFound()
		default: {
			const exhaustive: never = input.result
			throw new Error(`Unknown package file raw result: ${exhaustive}`)
		}
	}
}

export function createCommunityPackageRawHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				return new Response('Method not allowed', { status: 405 })
			}
			const selectedPath = normalizePackageFilesPath(
				typeof params.relativePath === 'string' ? params.relativePath : '',
			)
			if (selectedPath == null || selectedPath === '') {
				return rawNotFound()
			}
			const result = await loadAccessiblePackageFileRaw({
				env,
				request,
				username: params.username,
				kodyId: params.kodyId,
				selectedPath,
				ref: params.ref,
			})
			return respondRaw({ request, result })
		},
	} satisfies Action<typeof routes.communityPackageRaw>
}

export function createCommunityDetailRawHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				return new Response('Method not allowed', { status: 405 })
			}
			const selectedPath = normalizePackageFilesPath(
				typeof params.relativePath === 'string' ? params.relativePath : '',
			)
			if (selectedPath == null || selectedPath === '') {
				return rawNotFound()
			}
			const result = await loadCommunityPackageFileRaw({
				env,
				request,
				listingId: params.listingId,
				selectedPath,
			})
			return respondRaw({ request, result })
		},
	} satisfies Action<typeof routes.communityDetailRaw>
}
