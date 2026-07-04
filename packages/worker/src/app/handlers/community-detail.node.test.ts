import { expect, test, vi } from 'vitest'
import { CommunityActionError } from '#worker/community/errors.ts'
import { createCommunityReportApiPostHandler } from './community-detail.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	reportCommunityListing: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	reportCommunityListing: (...args: Array<unknown>) =>
		mockModule.reportCommunityListing(...args),
	getCommunityListingWithAggregates: vi.fn(),
}))

const env = {} as Env

test('community report POST requires authentication', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)

	const handler = createCommunityReportApiPostHandler(env)
	const response = await handler.handler({
		request: new Request(
			'https://example.com/community/listing-1/report.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'Spam content' }),
			},
		),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1/report.json'),
	} as never)
	const body = await response.json()

	expect(response.status).toBe(401)
	expect(body).toEqual({ ok: false, error: 'Unauthorized.' })
	expect(mockModule.reportCommunityListing).not.toHaveBeenCalled()
})

test('community report POST uses MCP-space user id', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'stable-reporter-id' },
	})
	mockModule.reportCommunityListing.mockResolvedValue({ id: 'report-1' })

	const handler = createCommunityReportApiPostHandler(env)
	const response = await handler.handler({
		request: new Request(
			'https://example.com/community/listing-1/report.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'Unsafe imports' }),
			},
		),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1/report.json'),
	} as never)
	const body = await response.json()

	expect(response.status).toBe(200)
	expect(body).toEqual({ ok: true })
	expect(mockModule.reportCommunityListing).toHaveBeenCalledWith({
		env,
		userId: 'stable-reporter-id',
		listingId: 'listing-1',
		reason: 'Unsafe imports',
	})
})

test('community report POST validates reason length', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'stable-reporter-id' },
	})

	const handler = createCommunityReportApiPostHandler(env)
	const response = await handler.handler({
		request: new Request(
			'https://example.com/community/listing-1/report.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: '   ' }),
			},
		),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1/report.json'),
	} as never)
	const body = await response.json()

	expect(response.status).toBe(400)
	expect(body.ok).toBe(false)
	expect(mockModule.reportCommunityListing).not.toHaveBeenCalled()
})

test('community report POST returns 400 for user-facing service errors', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'stable-reporter-id' },
	})
	mockModule.reportCommunityListing.mockRejectedValue(
		new CommunityActionError('banned from community participation'),
	)

	const handler = createCommunityReportApiPostHandler(env)
	const response = await handler.handler({
		request: new Request(
			'https://example.com/community/listing-1/report.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'Spam content' }),
			},
		),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1/report.json'),
	} as never)
	const body = await response.json()

	expect(response.status).toBe(400)
	expect(body).toEqual({
		ok: false,
		error: 'banned from community participation',
	})
})

test('community report POST returns 500 for unexpected service errors', async () => {
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'stable-reporter-id' },
	})
	mockModule.reportCommunityListing.mockRejectedValue(new Error('db timeout'))

	const handler = createCommunityReportApiPostHandler(env)
	const response = await handler.handler({
		request: new Request(
			'https://example.com/community/listing-1/report.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'Spam content' }),
			},
		),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1/report.json'),
	} as never)
	const body = await response.json()

	expect(response.status).toBe(500)
	expect(body).toEqual({ ok: false, error: 'Unable to submit report.' })
	expect(consoleError).toHaveBeenCalled()
	consoleError.mockRestore()
})
