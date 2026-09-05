import { expect, test } from 'vitest'
import { listRegisteredFrameNames } from '#app/frame-registry.ts'
import '#app/frame-registrations.ts'
import {
	COMMUNITY_DETAIL_TARGET,
	COMMUNITY_LISTINGS_TARGET,
} from '#universal/community-frame-constants.ts'
import { PROFILE_TARGET } from '#universal/profile-frame-constants.ts'

/**
 * `registerFrame` replaces on a repeated name so Vite HMR can re-run a frame
 * module; that moves duplicate-name detection here. Every module imported by
 * `frame-registrations.ts` must contribute its own distinct name, so the
 * registered set is exactly one entry per frame module.
 */
test('each frame module registers a distinct frame name', () => {
	expect(listRegisteredFrameNames().sort()).toEqual(
		[COMMUNITY_LISTINGS_TARGET, COMMUNITY_DETAIL_TARGET, PROFILE_TARGET].sort(),
	)
})
