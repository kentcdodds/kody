import { expect, test, vi } from 'vitest'
import {
	deleteAccountCommunityAssetPrefixes,
	deleteAccountEmailBlobPrefixes,
} from './account-r2-prefix-cleanup.ts'

test('community asset prefix cleanup paginates and preserves other users', async () => {
	const keys = new Set([
		'user-avatars/user-aaa/current.png',
		'user-avatars/user-aaa/historical.png',
		'user-avatars/user-bbb/other.png',
		'community-icon:v1/listing-a/current/asset',
		'community-icon:v1/listing-a/historical/asset',
		'community-icon:v1/listing-b/other/asset',
	])
	const list = vi.fn(async (options?: { prefix?: string; cursor?: string }) => {
		const matches = [...keys]
			.filter(
				(key) =>
					key.startsWith(options?.prefix ?? '') &&
					(!options?.cursor || key > options.cursor),
			)
			.sort()
		const objects = matches.slice(0, 1).map((key) => ({ key }))
		return {
			objects,
			delimitedPrefixes: [],
			...(matches.length > objects.length
				? { truncated: true as const, cursor: objects[0]!.key }
				: { truncated: false as const }),
		}
	})
	const deleted: Array<string> = []
	const count = await deleteAccountCommunityAssetPrefixes({
		bucket: {
			list,
			async delete(value: string | Array<string>) {
				for (const key of Array.isArray(value) ? value : [value]) {
					deleted.push(key)
					keys.delete(key)
				}
			},
		},
		stableUserId: 'user-aaa',
		listingIds: ['listing-a'],
	})
	expect(count).toBe(4)
	expect(list).toHaveBeenCalledTimes(4)
	expect(deleted.sort()).toEqual([
		'community-icon:v1/listing-a/current/asset',
		'community-icon:v1/listing-a/historical/asset',
		'user-avatars/user-aaa/current.png',
		'user-avatars/user-aaa/historical.png',
	])
	expect(keys).toEqual(
		new Set([
			'community-icon:v1/listing-b/other/asset',
			'user-avatars/user-bbb/other.png',
		]),
	)
})

test('community asset prefix cleanup fails closed on listing or deletion errors', async () => {
	await expect(
		deleteAccountCommunityAssetPrefixes({
			bucket: {
				async list() {
					throw new Error('list unavailable')
				},
				delete: vi.fn(),
			},
			stableUserId: 'user-aaa',
			listingIds: [],
		}),
	).rejects.toThrow('User avatar prefix listing failed')

	await expect(
		deleteAccountCommunityAssetPrefixes({
			bucket: {
				async list() {
					return {
						objects: [{ key: 'user-avatars/user-aaa/old.png' }],
						delimitedPrefixes: [],
						truncated: false,
					}
				},
				async delete() {
					throw new Error('delete unavailable')
				},
			},
			stableUserId: 'user-aaa',
			listingIds: [],
		}),
	).rejects.toThrow('User avatar prefix delete failed')
})

test('email prefix cleanup removes orphan raw MIME and attachment objects', async () => {
	const keys = new Set([
		'email-raw:v1:user-aaa/orphan',
		'email-attachment:v1:user-aaa/message/attachment',
		'email-raw:v1:user-bbb/other',
	])
	const count = await deleteAccountEmailBlobPrefixes({
		bucket: {
			async list(options?: { prefix?: string }) {
				return {
					objects: [...keys]
						.filter((key) => key.startsWith(options?.prefix ?? ''))
						.map((key) => ({ key })),
					delimitedPrefixes: [],
					truncated: false,
				}
			},
			async delete(value: string | Array<string>) {
				for (const key of Array.isArray(value) ? value : [value]) {
					keys.delete(key)
				}
			},
		},
		stableUserId: 'user-aaa',
	})
	expect(count).toBe(2)
	expect(keys).toEqual(new Set(['email-raw:v1:user-bbb/other']))
})
