import {
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	pageHeaderCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'

export type OAuthAuthorizeStatus = 'idle' | 'loading' | 'ready' | 'error'

export function oauthAuthorizeAccessLead(
	status: OAuthAuthorizeStatus,
	clientLabel: string,
) {
	switch (status) {
		case 'ready':
			return `${clientLabel} wants to access your kody account.`
		case 'idle':
		case 'loading':
			return 'Loading authorization details…'
		case 'error':
			return null
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

export const oauthAuthorizePageCss = {
	...stackedPageCss,
	maxWidth: '28rem',
	margin: '0 auto',
}

export const oauthAuthorizeHeaderCss = pageHeaderCss

export const oauthAuthorizePrimaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

export const oauthAuthorizeSecondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

export const oauthAuthorizeDangerButtonCss = getDangerButtonCss({
	size: 'lg',
	weight: 'semibold',
})
