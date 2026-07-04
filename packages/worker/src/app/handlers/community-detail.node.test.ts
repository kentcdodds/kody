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

test('community report POST enforces auth, validation, and error mapping', async () => {
	const handler = createCommunityReportApiPostHandler(env)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await handler.handler({
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
	expect(unauthorized.status).toBe(401)
	expect(await unauthorized.json()).toEqual({
		ok: false,
		error: 'Unauthorized.',
	})
	expect(mockModule.reportCommunityListing).not.toHaveBeenCalled()

	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'stable-reporter-id' },
	})
	const invalidReason = await handler.handler({
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
	expect(invalidReason.status).toBe(400)
	expect((await invalidReason.json()).ok).toBe(false)
	expect(mockModule.reportCommunityListing).not.toHaveBeenCalled()

	mockModule.reportCommunityListing.mockResolvedValue({ id: 'report-1' })
	const success = await handler.handler({
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
	expect(success.status).toBe(200)
	expect(await success.json()).toEqual({ ok: true })
	expect(mockModule.reportCommunityListing).toHaveBeenCalledWith({
		env,
		userId: 'stable-reporter-id',
		listingId: 'listing-1',
		reason: 'Unsafe imports',
	})

	mockModule.reportCommunityListing.mockRejectedValue(
		new CommunityActionError('banned from community participation'),
	)
	const userFacingError = await handler.handler({
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
	expect(userFacingError.status).toBe(400)
	expect(await userFacingError.json()).toEqual({
		ok: false,
		error: 'banned from community participation',
	})

	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	mockModule.reportCommunityListing.mockRejectedValue(new Error('db timeout'))
	const serverError = await handler.handler({
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
	expect(serverError.status).toBe(500)
	expect(await serverError.json()).toEqual({
		ok: false,
		error: 'Unable to submit report.',
	})
	expect(consoleError).toHaveBeenCalled()
	consoleError.mockRestore()
})
