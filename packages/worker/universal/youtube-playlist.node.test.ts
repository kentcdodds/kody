import { expect, test } from 'vitest'
import {
	parseYoutubePlaylistBrowseJson,
	parseYoutubePlaylistItemsApi,
	uniqueLandingHeroVideos,
	youtubePlaylistItemsApiUrl,
} from './youtube-playlist.ts'

const first = {
	videoId: 'iGMkgjXc8Ho',
	title: 'Build in Cursor, then run it from Claude Code or ChatGPT',
}
const second = {
	videoId: 'QA0xYMAMjEg',
	title: 'Introducing Kody: Your Personal Software Factory',
}

test('YouTube Data API playlistItems stay in playlist order and skip private rows', () => {
	const parsed = parseYoutubePlaylistItemsApi({
		items: [
			{
				snippet: {
					title: first.title,
					resourceId: { videoId: first.videoId },
					position: 0,
				},
			},
			{
				snippet: {
					title: 'Private video',
					resourceId: { videoId: 'o5L5OprLhBg' },
					position: 1,
				},
			},
			{
				snippet: {
					title: second.title,
					resourceId: { videoId: second.videoId },
					position: 2,
				},
			},
		],
		nextPageToken: 'next-page',
	})
	expect(parsed.videos).toEqual([first, second])
	expect(parsed.nextPageToken).toBe('next-page')
	expect(
		youtubePlaylistItemsApiUrl({
			playlistId: 'PLBPBUA8boGLA',
			apiKey: 'test-key',
			pageToken: 'next-page',
		}),
	).toContain('pageToken=next-page')
})

test('Innertube browse JSON keeps lockup order and ignores sidebar-only junk', () => {
	const parsed = parseYoutubePlaylistBrowseJson({
		contents: {
			twoColumnBrowseResultsRenderer: {
				tabs: [
					{
						tabRenderer: {
							content: {
								sectionListRenderer: {
									contents: [
										{
											itemSectionRenderer: {
												contents: [
													{
														lockupViewModel: {
															contentId: first.videoId,
															contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
															metadata: {
																lockupMetadataViewModel: {
																	title: { content: first.title },
																},
															},
														},
													},
													{
														lockupViewModel: {
															contentId: second.videoId,
															contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
															metadata: {
																lockupMetadataViewModel: {
																	title: { content: second.title },
																},
															},
														},
													},
													{
														continuationItemViewModel: {
															continuationCommand: { token: 'page-2' },
														},
													},
												],
											},
										},
									],
								},
							},
						},
					},
				],
			},
		},
	})
	expect(parsed.videos).toEqual([first, second])
	expect(parsed.continuation).toBe('page-2')
})

test('Innertube browse JSON also reads playlistVideoRenderer rows', () => {
	const parsed = parseYoutubePlaylistBrowseJson({
		contents: {
			playlistVideoRenderer: {
				videoId: first.videoId,
				title: { runs: [{ text: first.title }] },
			},
		},
	})
	expect(parsed.videos).toEqual([first])
})

test('Innertube browse JSON ignores sidebar lockups outside the playlist column', () => {
	const sidebarLockup = {
		lockupViewModel: {
			contentId: second.videoId,
			contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
			metadata: {
				lockupMetadataViewModel: {
					title: { content: second.title },
				},
			},
		},
		continuationItemViewModel: {
			continuationCommand: { token: 'sidebar-token' },
		},
	}
	const parsed = parseYoutubePlaylistBrowseJson({
		contents: {
			twoColumnBrowseResultsRenderer: {
				tabs: [
					{
						tabRenderer: {
							content: {
								sectionListRenderer: {
									contents: [
										{
											itemSectionRenderer: {
												contents: [
													{
														lockupViewModel: {
															contentId: first.videoId,
															contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
															metadata: {
																lockupMetadataViewModel: {
																	title: { content: first.title },
																},
															},
														},
													},
												],
											},
										},
									],
								},
							},
						},
					},
				],
				secondaryContents: sidebarLockup,
			},
			secondaryContents: sidebarLockup,
		},
	})
	expect(parsed.videos).toEqual([first])
	expect(parsed.continuation).toBeNull()
})

test('uniqueLandingHeroVideos drops duplicates and invalid rows', () => {
	expect(
		uniqueLandingHeroVideos([
			first,
			{ videoId: first.videoId, title: 'duplicate' },
			{ videoId: 'not-an-id', title: 'nope' },
			second,
		]),
	).toEqual([first, second])
})
