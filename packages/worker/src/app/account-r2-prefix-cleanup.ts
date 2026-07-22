import { getErrorMessage } from '@kody-internal/shared/error-message.ts'

function userAvatarPrefix(stableUserId: string) {
	return `user-avatars/${stableUserId}/`
}

function communityIconPrefix(listingId: string) {
	return `community-icon:v1/${listingId}/`
}

async function deletePrefixStrict(input: {
	bucket: Pick<R2Bucket, 'list' | 'delete'>
	prefix: string
	label: string
}) {
	let deleted = 0
	let cursor: string | undefined
	do {
		let page: R2Objects
		try {
			page = await input.bucket.list({ prefix: input.prefix, cursor })
		} catch (error) {
			throw new Error(
				`${input.label} prefix listing failed for ${input.prefix}: ${getErrorMessage(error)}`,
			)
		}
		const keys = page.objects.map((object) => object.key)
		const outOfScope = keys.find((key) => !key.startsWith(input.prefix))
		if (outOfScope) {
			throw new Error(
				`${input.label} prefix listing returned an out-of-scope key for ${input.prefix}: ${outOfScope}`,
			)
		}
		if (keys.length > 0) {
			try {
				await input.bucket.delete(keys)
				deleted += keys.length
			} catch (error) {
				throw new Error(
					`${input.label} prefix delete failed for ${input.prefix}: ${getErrorMessage(error)}`,
				)
			}
		}
		cursor = page.truncated ? page.cursor : undefined
	} while (cursor)
	return deleted
}

export async function deleteAccountCommunityAssetPrefixes(input: {
	bucket: Pick<R2Bucket, 'list' | 'delete'>
	stableUserId: string
	listingIds: ReadonlyArray<string>
}) {
	let deleted = await deletePrefixStrict({
		bucket: input.bucket,
		prefix: userAvatarPrefix(input.stableUserId),
		label: 'User avatar',
	})
	for (const listingId of new Set(input.listingIds)) {
		deleted += await deletePrefixStrict({
			bucket: input.bucket,
			prefix: communityIconPrefix(listingId),
			label: 'Community icon',
		})
	}
	return deleted
}

export async function deleteAccountEmailBlobPrefixes(input: {
	bucket: Pick<R2Bucket, 'list' | 'delete'>
	stableUserId: string
}) {
	return (
		(await deletePrefixStrict({
			bucket: input.bucket,
			prefix: `email-raw:v1:${input.stableUserId}/`,
			label: 'Email raw MIME',
		})) +
		(await deletePrefixStrict({
			bucket: input.bucket,
			prefix: `email-attachment:v1:${input.stableUserId}/`,
			label: 'Email attachment',
		}))
	)
}
