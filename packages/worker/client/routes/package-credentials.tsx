// remix-skill: package Credentials, Default mappings, and Triggers tabs (`/@user/name/<tab>`).
import { type Handle, css } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { NotFoundPage } from '#client/not-found-page.tsx'
import {
	createRouteData,
	renderRoutePendingStatus,
	routeDataRedirect,
} from '#client/route-data.tsx'
import { readRouterPathname } from '#client/router-location.tsx'
import { resolvePackageListIconUrl } from '#universal/identity-icon-urls.ts'
import {
	type PackageCredentialsEnablementAction,
	type PackageCredentialsView,
} from '#universal/credential-contracts.ts'
import {
	type PackageCredentialsLoaderData,
	type PackageCredentialsTab,
	packageCredentialsTabLabel,
	readPackageCredentialsTabPath,
} from '#universal/package-credentials-page.ts'
import {
	fallbackDefaultBranchName,
	getPackageTreeHref,
} from '#universal/package-files.ts'
import { renderPackageRepoChrome } from '#universal/package-repo-nav.tsx'
import { cardCss, cardTitleCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	detailArticleCss,
	renderShellStatus,
} from './community-detail-sections.tsx'
import { loadPackageCredentialsPage } from './package-credentials-data.ts'
import { postPackageCredentialChanges } from './package-credentials-editing.ts'
import { createPackageMappingEditor } from './package-credentials-editor.tsx'
import {
	type PackageTabContext,
	type TriggerEnablementActionInput,
	renderCredentialsTab,
	renderMappingsTab,
	renderTriggersTab,
} from './package-credentials-tabs.tsx'

function renderTab(tab: PackageCredentialsTab, context: PackageTabContext) {
	switch (tab) {
		case 'credentials':
			return renderCredentialsTab(context)
		case 'mappings':
			return renderMappingsTab(context)
		case 'triggers':
			return renderTriggersTab(context)
		default: {
			const exhaustive: never = tab
			return exhaustive
		}
	}
}

function packageCredentialsAgentPrompt(input: {
	pageUrl: string
	error: string
}) {
	return [
		`I opened my package's credentials on Kody: ${input.pageUrl}`,
		`Kody said: ${input.error}`,
		'Help me find out why. Do not ask me to paste any credential value into chat.',
	].join('\n')
}

function renderViewError(input: { pageUrl: string; error: string }) {
	return (
		<section
			role="alert"
			data-testid="package-credentials-error"
			mix={css({
				...cardCss,
				borderLeft: `4px solid ${colors.danger}`,
				justifyItems: 'start',
				gap: spacing.sm,
			})}
		>
			<h2 mix={css(cardTitleCss)}>Kody could not load these credentials</h2>
			<p mix={css({ margin: 0 })}>{input.error}</p>
			<CopyTextButton
				value={packageCredentialsAgentPrompt(input)}
				idleLabel="Copy prompt for your agent"
			/>
		</section>
	)
}

export function PackageCredentialsRoute(handle: Handle) {
	const pageData = createRouteData<
		'packageCredentials',
		PackageCredentialsLoaderData
	>({
		key: 'packageCredentials',
		fromLoaderData: (payload) => payload,
		async load(href, signal) {
			const writesAtStart = writes
			const result = await loadPackageCredentialsPage(href, signal)
			if (result.kind === 'redirect') return routeDataRedirect(result.to)
			if (result.data?.ok && result.data.view) {
				fetchedAfterWrites.set(result.data.view, writesAtStart)
			}
			return result.data
		},
	})

	let page = { username: '', kodyId: '', orgSlug: '' }
	let editorPathname: string | null = null
	let writes = 0
	/** Writes that had landed when each view's GET started. */
	const fetchedAfterWrites = new WeakMap<PackageCredentialsView, number>()
	/**
	 * The latest saved view, shown until a GET that started after that write
	 * lands; a GET already in flight (or router loader data) may predate it.
	 */
	let saved: {
		view: PackageCredentialsView
		writes: number
		packageKey: string
	} | null = null
	const packageKey = (target: { username: string; kodyId: string }) =>
		`${target.username}/${target.kodyId}`
	let reloadRequestedFor: PackageCredentialsView | null = null
	const editor = createPackageMappingEditor(handle, {
		readPage: () => page,
		onSaved(view, postedTo) {
			if (packageKey(postedTo) === packageKey(page)) {
				writes += 1
				saved = { view, writes, packageKey: packageKey(page) }
				handle.update()
			}
		},
	})
	let enablementBusyKey: string | null = null
	let enablementError: string | null = null
	let enablementSession = 0

	async function setTriggerEnablement(input: TriggerEnablementActionInput) {
		const busyKey =
			input.enablementId ?? `${input.trigger.kind}:${input.trigger.name}`
		if (enablementBusyKey) return
		enablementBusyKey = busyKey
		enablementError = null
		enablementSession += 1
		const started = enablementSession
		handle.update()
		const action: PackageCredentialsEnablementAction = {
			trigger: input.trigger,
			state: input.state,
			...(input.enablementId ? { enablementId: input.enablementId } : {}),
			...(input.createInstance ? { createInstance: true } : {}),
		}
		const postedTo = { ...page }
		const result = await postPackageCredentialChanges({
			username: postedTo.username,
			kodyId: postedTo.kodyId,
			enablements: [action],
		})
		if (enablementSession !== started) return
		enablementBusyKey = null
		switch (result.kind) {
			case 'saved':
				if (packageKey(postedTo) === packageKey(page)) {
					writes += 1
					saved = { view: result.view, writes, packageKey: packageKey(page) }
				}
				enablementError = null
				handle.update()
				return
			case 'refused':
				enablementError =
					result.errors[0]?.message ?? 'Kody could not update this trigger.'
				handle.update()
				return
			case 'error':
				enablementError = result.message
				handle.update()
				return
			case 'unauthorized':
				window.location.assign(
					`/login?redirectTo=${encodeURIComponent(window.location.pathname)}`,
				)
				return
			default: {
				const exhaustive: never = result
				return exhaustive
			}
		}
	}

	function currentView(
		loaded: PackageCredentialsView | null,
		currentHref: string,
		pending: boolean,
	) {
		if (!saved || saved.packageKey !== packageKey(page)) return loaded
		if (!loaded) return saved.view
		if (saved.view.package.id !== loaded.package.id) return loaded
		if ((fetchedAfterWrites.get(loaded) ?? -1) >= saved.writes) {
			saved = null
			return loaded
		}
		if (!pending && reloadRequestedFor !== loaded) {
			reloadRequestedFor = loaded
			pageData.reload(handle, currentHref)
		}
		return saved.view
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const pathname = readRouterPathname(handle)
		const path = readPackageCredentialsTabPath(pathname)
		if (!path) return <NotFoundPage />

		const snapshot = pageData.read(handle, currentHref)
		if (
			snapshot.kind === 'not-found' ||
			(snapshot.data?.ok === false && !snapshot.stale)
		) {
			return <NotFoundPage />
		}
		const data = snapshot.data?.ok ? snapshot.data : null
		const shell = data?.shell ?? null
		const username = shell?.username ?? path.username
		const kodyId = shell?.kodyId ?? path.kodyId
		page = { username, kodyId, orgSlug: username }
		if (pathname !== editorPathname) {
			editorPathname = pathname
			editor.reset()
		}
		const pending = snapshot.kind === 'pending'
		const view = currentView(data?.view ?? null, currentHref, pending)
		const statusMessage =
			snapshot.kind === 'error'
				? 'Unable to load this package.'
				: data
					? ''
					: `Loading ${packageCredentialsTabLabel(path.tab).toLowerCase()}…`
		const pageUrl =
			typeof window === 'undefined'
				? pathname
				: new URL(pathname, window.location.origin).href

		return (
			<article
				mix={css(detailArticleCss)}
				data-testid={`package-${path.tab}`}
				aria-busy={pending && data ? 'true' : undefined}
			>
				{pending && data ? renderRoutePendingStatus() : null}
				{renderPackageRepoChrome({
					username,
					kodyId,
					isPrivate: shell?.isPrivate ?? false,
					isListed: shell?.isListed ?? false,
					viewerIsOwner: true,
					viewerCanManage: shell?.viewerCanManage ?? false,
					viewerCanManageAccess: shell?.viewerCanManageAccess ?? false,
					active: path.tab,
					filesHref: getPackageTreeHref({
						username,
						kodyId,
						listingId: shell?.listingId ?? null,
						ref: shell?.defaultBranch || fallbackDefaultBranchName,
					}),
					description: shell?.description ?? '',
					ownerProfilePublic: shell?.ownerProfilePublic ?? true,
					iconUrl: resolvePackageListIconUrl({
						username,
						kodyId,
						listingId: shell?.listingId ?? null,
						listingIconCommit: null,
						publishedCommit: shell?.publishedCommit ?? null,
					}),
					iconName: kodyId,
				})}
				{renderShellStatus(statusMessage)}
				{view
					? renderTab(path.tab, {
							orgSlug: username,
							username,
							kodyId,
							view,
							renderMappingCell: editor.renderCell,
							setTriggerEnablement,
							enablementBusyKey,
							enablementError,
						})
					: null}
				{data && !data.view
					? renderViewError({
							pageUrl,
							error:
								data.viewError ??
								'Kody could not load this package’s credentials.',
						})
					: null}
			</article>
		)
	}
}
