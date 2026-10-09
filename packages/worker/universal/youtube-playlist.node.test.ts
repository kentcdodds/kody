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

function lockup(video: { videoId: string; title: string }) {
	return {
		lockupViewModel: {
			contentId: video.videoId,
			contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
			metadata: {
				lockupMetadataViewModel: { title: { content: video.title } },
			},
		},
	}
}

function browseJson(items: Array<unknown>, columnExtras: object = {}) {
	return {
		twoColumnBrowseResultsRenderer: {
			tabs: [
				{
					tabRenderer: {
						content: {
							sectionListRenderer: {
								contents: [{ itemSectionRenderer: { contents: items } }],
							},
						},
					},
				},
			],
			...columnExtras,
		},
	}
}

test('Innertube browse JSON keeps lockup order, reads playlistVideoRenderer rows, and ignores sidebar-only junk', () => {
	const parsed = parseYoutubePlaylistBrowseJson({
		contents: browseJson([
			lockup(first),
			lockup(second),
			{
				continuationItemViewModel: { continuationCommand: { token: 'page-2' } },
			},
		]),
	})
	expect(parsed.videos).toEqual([first, second])
	expect(parsed.continuation).toBe('page-2')

	expect(
		parseYoutubePlaylistBrowseJson({
			contents: {
				playlistVideoRenderer: {
					videoId: first.videoId,
					title: { runs: [{ text: first.title }] },
				},
			},
		}).videos,
	).toEqual([first])

	const sidebarLockup = {
		...lockup(second),
		continuationItemViewModel: {
			continuationCommand: { token: 'sidebar-token' },
		},
	}
	const withSidebar = parseYoutubePlaylistBrowseJson({
		contents: {
			...browseJson([lockup(first)], { secondaryContents: sidebarLockup }),
			secondaryContents: sidebarLockup,
		},
	})
	expect(withSidebar.videos).toEqual([first])
	expect(withSidebar.continuation).toBeNull()
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
