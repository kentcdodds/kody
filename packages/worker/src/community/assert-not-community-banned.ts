import { CommunityActionError } from './errors.ts'
import { getCommunityBan } from './repo.ts'

export async function assertNotCommunityBanned(db: D1Database, userId: string) {
	const ban = await getCommunityBan(db, userId)
	if (ban) {
		throw new CommunityActionError('banned from community participation')
	}
}
