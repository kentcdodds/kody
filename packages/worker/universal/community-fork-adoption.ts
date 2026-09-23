import { routes } from '#universal/routes.ts'

export const communityForkAdoptionSectionId = 'community-fork-adoption'

export const communityForkAdoptionReviewNoteMinLength = 10

export function buildCommunityForkAdoptionHref(input: {
	username: string
	kodyId: string
}) {
	return `${routes.communityPackageSettings.href(input)}#${communityForkAdoptionSectionId}`
}
