import { mergeAssets, type ImportedAssets } from '@pitlane/dev/runtime'
import {
	clientRouteAreaNameForPath,
	type ClientRouteAreaName,
} from '#client/lazy-route.tsx'
import entryAssets from '#client/entry.tsx?assets=client'
import accountAreaAssets from '#client/routes/account-area.ts?assets=client'
import adminAreaAssets from '#client/routes/admin-area.ts?assets=client'
import authAreaAssets from '#client/routes/auth-area.ts?assets=client'
import blogAreaAssets from '#client/routes/blog-area.ts?assets=client'
import communityAreaAssets from '#client/routes/community-area.ts?assets=client'
import marketingAreaAssets from '#client/routes/marketing-area.ts?assets=client'
import onboardingAreaAssets from '#client/routes/onboarding-area.ts?assets=client'
import packageFilesAreaAssets from '#client/routes/package-files-area.ts?assets=client'

const areaAssets = {
	'account-area': accountAreaAssets,
	'admin-area': adminAreaAssets,
	'auth-area': authAreaAssets,
	'blog-area': blogAreaAssets,
	'community-area': communityAreaAssets,
	'marketing-area': marketingAreaAssets,
	'onboarding-area': onboardingAreaAssets,
	'package-files-area': packageFilesAreaAssets,
} satisfies Record<ClientRouteAreaName, ImportedAssets>

export function getClientEntryAssets(pathname: string): ImportedAssets {
	const areaName = clientRouteAreaNameForPath(pathname)
	if (!areaName) return entryAssets
	return mergeAssets(entryAssets, areaAssets[areaName])
}
