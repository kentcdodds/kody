import { addEventListeners, type Handle } from 'remix/ui'
import { createMultiMatcher } from 'remix/route-pattern/match'
import { type AppLoaderData } from '#app/loader-data.ts'
import { applyDocumentTitle } from './document-title.ts'
import {
	abortIntentPrefetch,
	prefetchRouteOnIntent,
	takePrefetchedRouteResult,
} from './intent-prefetch.ts'
import {
	markNavigationDataStale,
	setPreloadedNavigationData,
} from './navigation-data.ts'
import { isRouteLoaderRedirect, type RouteLoader } from './route-loader.ts'
import {
	readRouterPathname,
	readRouterUrl,
	readSsrRouterUrl,
} from './router-location.tsx'
import {
	createScrollRestorationHistoryState,
	ensureCurrentScrollRestorationKey,
	type RouterHistoryAction,
	type RouterNavigateOptions,
	type RouterNavigationEventDetail,
} from './router-scroll-state.ts'

export { type RouteLoader } from './route-loader.ts'

type RouterSetup = {
	routes: Record<string, JSX.Element>
	fallback?: JSX.Element
	loaderData?: AppLoaderData
	notFound?: boolean
}

type FormMethod = 'get' | 'post'

type FormSubmitDetails = {
	action: URL
	method: FormMethod
	enctype: string
	formData: FormData
	preventScrollReset: boolean
}

type NavigationRunOptions = {
	/** Browser already changed the URL (popstate / same-path refresh). */
	skipPushState?: boolean
	/** Form POST already dispatched `navigationstart`; loader owns `navigationend`. */
	suppressStart?: boolean
	historyAction?: RouterHistoryAction
} & RouterNavigateOptions

const clientRouteOrigin = 'https://kody.local'
const routeMatchers = new WeakMap<
	Record<string, JSX.Element>,
	ReturnType<typeof createRouteMatcher>
>()
const loaderMatchers = new WeakMap<
	Record<string, RouteLoader>,
	ReturnType<typeof createLoaderMatcher>
>()
export const routerEvents = new EventTarget()
let routerInitialized = false
let registeredRouteLoaders: Record<string, RouteLoader> = {}
let navigationAbortController: AbortController | null = null
let activeNavigationPath: string | null = null
// The pathname+search (no hash) the app last rendered. Popstate compares
// against this to detect hash-only history moves, since `window.location`
// has already changed by the time the event fires.
let lastNotifiedDocumentPath: string | null = null

function getCurrentDocumentPath() {
	return `${window.location.pathname}${window.location.search}`
}

function notify() {
	lastNotifiedDocumentPath = getCurrentDocumentPath()
	routerEvents.dispatchEvent(new Event('navigate'))
}

function createNavigationEventDetail(
	location: string,
	options?: NavigationRunOptions,
): RouterNavigationEventDetail {
	return {
		location,
		historyAction:
			options?.historyAction ?? (options?.skipPushState ? 'replace' : 'push'),
		preventScrollReset: options?.preventScrollReset ?? false,
	}
}

function dispatchNavigationStart(options?: NavigationRunOptions) {
	routerEvents.dispatchEvent(
		new CustomEvent<RouterNavigationEventDetail>('navigationstart', {
			detail: createNavigationEventDetail(
				getCurrentPathWithSearchAndHash(),
				options,
			),
		}),
	)
}

function dispatchNavigationEnd(detail: RouterNavigationEventDetail) {
	routerEvents.dispatchEvent(
		new CustomEvent<RouterNavigationEventDetail>('navigationend', {
			detail,
		}),
	)
}

function createRouteMatcher(routes: Record<string, JSX.Element>) {
	const matcher = createMultiMatcher<JSX.Element>()
	for (const [pattern, routeElement] of Object.entries(routes)) {
		matcher.add(pattern, routeElement)
	}
	return matcher
}

function createLoaderMatcher(loaders: Record<string, RouteLoader>) {
	const matcher = createMultiMatcher<RouteLoader>()
	for (const [pattern, loader] of Object.entries(loaders)) {
		matcher.add(pattern, loader)
	}
	return matcher
}

function getRouteMatcher(routes: Record<string, JSX.Element>) {
	const existing = routeMatchers.get(routes)
	if (existing) return existing
	const matcher = createRouteMatcher(routes)
	routeMatchers.set(routes, matcher)
	return matcher
}

function getLoaderMatcher(loaders: Record<string, RouteLoader>) {
	const existing = loaderMatchers.get(loaders)
	if (existing) return existing
	const matcher = createLoaderMatcher(loaders)
	loaderMatchers.set(loaders, matcher)
	return matcher
}

export function registerRouteLoaders(loaders: Record<string, RouteLoader>) {
	registeredRouteLoaders = loaders
	loaderMatchers.delete(loaders)
}

export function matchRouteLoader(
	path: string | URL,
	loaders: Record<string, RouteLoader> = registeredRouteLoaders,
): RouteLoader | null {
	const url = typeof path === 'string' ? new URL(path, clientRouteOrigin) : path
	return getLoaderMatcher(loaders).match(url)?.data ?? null
}

export function matchRoute(
	path: string,
	routes: Record<string, JSX.Element>,
): JSX.Element | null {
	return (
		getRouteMatcher(routes).match(new URL(path, clientRouteOrigin))?.data ??
		null
	)
}

function shouldHandleClick(event: MouseEvent, anchor: HTMLAnchorElement) {
	if (event.defaultPrevented) return false
	if (event.button !== 0) return false
	if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey)
		return false
	if (anchor.target && anchor.target !== '_self') return false
	if (anchor.hasAttribute('download')) return false

	const href = anchor.getAttribute('href')
	if (!href || href.startsWith('#')) return false

	const destination = new URL(href, window.location.href)
	if (destination.origin !== window.location.origin) return false
	return true
}

function handleDocumentClick(event: MouseEvent) {
	const target = event.target as Element | null
	const anchor = target?.closest('a') as HTMLAnchorElement | null
	if (!anchor || typeof window === 'undefined') return
	if (!shouldHandleClick(event, anchor)) return

	event.preventDefault()
	const destination = new URL(anchor.href, window.location.href)
	navigate(`${destination.pathname}${destination.search}${destination.hash}`, {
		preventScrollReset: anchor.hasAttribute('data-prevent-scroll-reset'),
	})
}

type PrefetchableLink = {
	anchor: HTMLAnchorElement
	destination: URL
}

function getPrefetchableLink(
	target: EventTarget | null,
): PrefetchableLink | null {
	if (!(target instanceof Element)) return null
	const anchor = target.closest('a')
	if (!anchor || typeof window === 'undefined') return null
	if (anchor.dataset.prefetch === 'none') return null
	if (anchor.target && anchor.target !== '_self') return null
	if (anchor.hasAttribute('download')) return null

	const href = anchor.getAttribute('href')
	if (!href || href.startsWith('#')) return null

	const destination = new URL(href, window.location.href)
	if (destination.origin !== window.location.origin) return null
	if (
		getPathWithSearchAndHashFromUrl(destination) ===
		getCurrentPathWithSearchAndHash()
	) {
		return null
	}
	return { anchor, destination }
}

function runIntentPrefetch(destination: URL) {
	const destinationPath = getPathWithSearchAndHashFromUrl(destination)
	// Never speculatively refetch the page the user is already on, or the one
	// a navigation is already loading (clicking a link focuses it, and that
	// focusin lands after the navigation consumed the prefetch slot).
	if (destinationPath === getCurrentPathWithSearchAndHash()) return
	if (destinationPath === activeNavigationPath) return
	const loader = matchRouteLoader(destination)
	if (!loader) return
	prefetchRouteOnIntent(
		getPathWithSearchAndHashFromUrl(destination),
		loader,
		destination,
	)
}

/**
 * Hovers shorter than this are treated as the mouse passing through, not
 * intent to navigate, so sweeping across a nav list does not fire a
 * speculative request per link crossed.
 */
const hoverIntentDelayMs = 100

let hoverIntentAnchor: HTMLAnchorElement | null = null
let hoverIntentTimer: ReturnType<typeof setTimeout> | null = null

function cancelHoverIntent() {
	if (hoverIntentTimer !== null) {
		clearTimeout(hoverIntentTimer)
		hoverIntentTimer = null
	}
	hoverIntentAnchor = null
}

/**
 * Intent prefetch (hover / focus / touch on internal links, like React
 * Router's `prefetch="intent"`): speculatively runs the destination's route
 * loader so the data is already in flight — or already here — when the click
 * lands. Opt out per link with `data-prefetch="none"`.
 */
function handleIntentHoverStart(event: MouseEvent) {
	const link = getPrefetchableLink(event.target)
	if (!link) return
	if (hoverIntentAnchor === link.anchor) return

	cancelHoverIntent()
	hoverIntentAnchor = link.anchor
	hoverIntentTimer = setTimeout(() => {
		hoverIntentTimer = null
		hoverIntentAnchor = null
		runIntentPrefetch(link.destination)
	}, hoverIntentDelayMs)
}

function handleIntentHoverEnd(event: MouseEvent) {
	if (!hoverIntentAnchor) return
	if (
		!(event.target instanceof Node) ||
		!hoverIntentAnchor.contains(event.target)
	) {
		return
	}
	// mouseout between an anchor's children stays "hovering"; only cancel
	// when the pointer actually leaves the anchor.
	if (
		event.relatedTarget instanceof Node &&
		hoverIntentAnchor.contains(event.relatedTarget)
	) {
		return
	}
	cancelHoverIntent()
}

/** Focus and touch are deliberate; prefetch immediately without the delay. */
function handleImmediateIntent(event: Event) {
	const link = getPrefetchableLink(event.target)
	if (!link) return
	// A pending hover timer (possibly for a different link) must not fire
	// after this deliberate intent and abort its prefetch — the slot is
	// latest-wins and this is the latest intent.
	cancelHoverIntent()
	runIntentPrefetch(link.destination)
}

function getFormSubmitter(event: SubmitEvent) {
	const submitter = event.submitter
	if (
		submitter instanceof HTMLButtonElement ||
		submitter instanceof HTMLInputElement
	) {
		return submitter
	}
	return null
}

function normalizeFormMethod(rawMethod: string | null): FormMethod | null {
	const method = (rawMethod ?? 'get').trim().toLowerCase()
	if (method === 'get' || method === 'post') return method
	return null
}

function normalizeTarget(rawTarget: string | null) {
	return (rawTarget ?? '').trim().toLowerCase()
}

function createSubmitFormData(
	form: HTMLFormElement,
	submitter: HTMLButtonElement | HTMLInputElement | null,
) {
	return submitter ? new FormData(form, submitter) : new FormData(form)
}

function resolveFormSubmitDetails(
	form: HTMLFormElement,
	submitter: HTMLButtonElement | HTMLInputElement | null,
): FormSubmitDetails | null {
	const method = normalizeFormMethod(
		submitter?.getAttribute('formmethod') ?? form.getAttribute('method'),
	)
	if (!method) return null

	const target = normalizeTarget(
		submitter?.getAttribute('formtarget') ?? form.getAttribute('target'),
	)
	if (target && target !== '_self') return null

	const rawAction =
		submitter?.getAttribute('formaction') ?? form.getAttribute('action')
	const action = new URL(
		rawAction || window.location.href,
		window.location.href,
	)
	if (action.origin !== window.location.origin) return null

	const enctype = (
		submitter?.getAttribute('formenctype') ??
		form.getAttribute('enctype') ??
		'application/x-www-form-urlencoded'
	)
		.trim()
		.toLowerCase()

	return {
		action,
		method,
		enctype,
		formData: createSubmitFormData(form, submitter),
		preventScrollReset:
			form.hasAttribute('data-prevent-scroll-reset') ||
			submitter?.hasAttribute('data-prevent-scroll-reset') === true,
	}
}

function formDataToSearchParams(formData: FormData) {
	const params = new URLSearchParams()
	for (const [name, value] of formData.entries()) {
		params.append(name, getFormDataValueText(value))
	}
	return params
}

function formDataToPlainText(formData: FormData) {
	const lines: Array<string> = []
	for (const [name, value] of formData.entries()) {
		lines.push(`${name}=${getFormDataValueText(value)}`)
	}
	return lines.join('\r\n')
}

function getFormDataValueText(value: FormDataEntryValue) {
	if (typeof value === 'string') return value
	const fileName = (value as { name?: unknown }).name
	return typeof fileName === 'string' ? fileName : 'blob'
}

function buildGetDestination(action: URL, formData: FormData) {
	const destination = new URL(action.toString())
	destination.search = formDataToSearchParams(formData).toString()
	return destination
}

function getPathWithSearchAndHashFromUrl(url: URL) {
	return `${url.pathname}${url.search}${url.hash}`
}

function getCurrentPathWithSearchAndHash() {
	if (typeof window === 'undefined') return '/'
	return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function commitNavigation(nextPath: string) {
	window.history.pushState(
		createScrollRestorationHistoryState(window.history.state),
		'',
		nextPath,
	)
	notify()
}

function commitImmediateNavigation(
	nextPath: string,
	options?: NavigationRunOptions,
) {
	cancelHoverIntent()
	// A pending loader navigation must not commit after this immediate one
	// and clobber the URL we are about to push.
	navigationAbortController?.abort()
	navigationAbortController = null
	if (!options?.suppressStart) {
		dispatchNavigationStart(options)
	}
	commitNavigation(nextPath)
	dispatchNavigationEnd(createNavigationEventDetail(nextPath, options))
}

async function runNavigationWithLoader(
	destination: URL,
	options?: NavigationRunOptions,
) {
	// A hover-intent timer set right before the click (e.g. on mousedown)
	// must not fire after we navigate and prefetch the page we are already
	// heading to.
	cancelHoverIntent()
	navigationAbortController?.abort()
	const abortController = new AbortController()
	navigationAbortController = abortController
	const { signal } = abortController

	if (!options?.suppressStart) {
		dispatchNavigationStart(options)
	}

	const nextPath = getPathWithSearchAndHashFromUrl(destination)
	const navigationEndDetail = createNavigationEventDetail(nextPath, options)
	const loader = matchRouteLoader(destination)
	activeNavigationPath = nextPath

	// Adopt an intent prefetch when one is pending or fresh for this
	// destination; otherwise run the loader now. Tying the prefetch to this
	// navigation's signal keeps latest-wins abort semantics. Taken
	// unconditionally (even for loaderless destinations) so a prefetch for a
	// link the user did not follow never outlives this navigation.
	const prefetched = takePrefetchedRouteResult(nextPath, signal)

	try {
		let loadedData: Partial<AppLoaderData> | undefined
		if (loader) {
			const result = prefetched
				? await prefetched
				: await loader(destination, signal)
			if (signal.aborted) return
			if (isRouteLoaderRedirect(result)) {
				// The loader wants a full-document navigation (e.g. a 401 →
				// login redirect). When the browser URL already moved
				// (popstate), still sync the UI to it so the app does not
				// render the previous route under the new URL while the full
				// document navigation loads.
				if (options?.skipPushState) {
					notify()
				}
				dispatchNavigationEnd({
					...navigationEndDetail,
					preventScrollReset: true,
				})
				window.location.assign(result.to)
				return
			}
			loadedData = result
		}

		if (signal.aborted) return

		// Store and commit in the same synchronous block so a superseding
		// navigation can never leave consume-once data behind for a URL the
		// user did not land on.
		if (loadedData) {
			setPreloadedNavigationData(nextPath, loadedData)
		}

		// Document title lives outside the hydrated `#root` tree, so SSR
		// `<title>` would otherwise stick across SPA navigations. Resolve from
		// the shared registry (+ loader data for dynamic routes) here so every
		// route gets a title update without per-page wiring.
		applyDocumentTitle(destination.pathname, loadedData)

		if (options?.skipPushState) {
			notify()
		} else {
			commitNavigation(nextPath)
		}
		dispatchNavigationEnd(navigationEndDetail)
	} catch {
		if (signal.aborted) return
		// The loader failed, so no preloaded data exists for the committed
		// destination. Same-path refreshes (form POST redirects back to the
		// current URL) have no href change to trigger a route's fallback
		// refetch, so mark the destination stale for routes to consume.
		markNavigationDataStale(nextPath)
		applyDocumentTitle(destination.pathname)
		if (options?.skipPushState) {
			notify()
		} else {
			commitNavigation(nextPath)
		}
		dispatchNavigationEnd(navigationEndDetail)
	} finally {
		// A superseding navigation owns the marker now; only clear our own.
		if (navigationAbortController === abortController) {
			activeNavigationPath = null
		}
	}
}

async function navigateWithRefreshForSamePath(
	destination: URL,
	options?: Pick<NavigationRunOptions, 'suppressStart' | 'preventScrollReset'>,
) {
	if (
		getPathWithSearchAndHashFromUrl(destination) ===
		getCurrentPathWithSearchAndHash()
	) {
		await runNavigationWithLoader(new URL(window.location.href), {
			historyAction: 'replace',
			preventScrollReset: options?.preventScrollReset ?? false,
			skipPushState: true,
			suppressStart: options?.suppressStart,
		})
		return
	}
	await navigateInternal(destination.toString(), options)
}

async function submitFormThroughRouter(details: FormSubmitDetails) {
	if (details.method === 'get') {
		navigate(buildGetDestination(details.action, details.formData).toString(), {
			preventScrollReset: details.preventScrollReset,
		})
		return
	}

	// The POST is about to mutate server state, so any speculative loader data
	// fetched before the mutation must never be adopted by the follow-up
	// navigation — including a hover timer that has not fired yet.
	cancelHoverIntent()
	abortIntentPrefetch()

	// Participate in the latest-wins navigation chain: a newer navigation
	// aborts this submission's follow-up redirect navigation so a late
	// response cannot hijack the URL. The POST itself is a mutation and is
	// never cancelled client-side.
	navigationAbortController?.abort()
	const abortController = new AbortController()
	navigationAbortController = abortController
	const { signal } = abortController

	// One `navigationstart` covers the POST fetch and the follow-up loader run;
	// `navigateWithRefreshForSamePath` / `navigateInternal` suppress a second
	// start and own the matching `navigationend`.
	dispatchNavigationStart({
		preventScrollReset: details.preventScrollReset,
	})

	try {
		const init: RequestInit = {
			method: details.method.toUpperCase(),
			credentials: 'include',
			redirect: 'follow',
		}

		if (details.enctype === 'application/x-www-form-urlencoded') {
			init.body = formDataToSearchParams(details.formData)
			init.headers = {
				'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
			}
		} else if (details.enctype === 'text/plain') {
			init.body = formDataToPlainText(details.formData)
			init.headers = {
				'Content-Type': 'text/plain;charset=UTF-8',
			}
		} else {
			init.body = details.formData
		}

		const response = await fetch(details.action.toString(), init)
		// The server processed the mutation no matter which navigation follows
		// (even if a newer navigation aborted this one). Tell listeners that
		// server-derived state they cache — like the shell's session info —
		// may now be stale.
		routerEvents.dispatchEvent(new Event('mutation'))
		if (signal.aborted) return

		if (response.redirected) {
			await navigateWithRefreshForSamePath(
				new URL(response.url, window.location.href),
				{
					preventScrollReset: details.preventScrollReset,
					suppressStart: true,
				},
			)
			return
		}

		const location = response.headers.get('Location')
		if (location) {
			await navigateWithRefreshForSamePath(new URL(location, details.action), {
				preventScrollReset: details.preventScrollReset,
				suppressStart: true,
			})
			return
		}

		throw new Error(
			`Expected redirect location after form submit (${response.status} ${response.statusText})`,
		)
	} catch (error: unknown) {
		console.error('Router form submit failed', error)
		if (signal.aborted) return
		dispatchNavigationEnd(
			createNavigationEventDetail(getCurrentPathWithSearchAndHash(), {
				historyAction: 'replace',
				preventScrollReset: true,
			}),
		)
	}
}

function handleDocumentSubmit(event: Event) {
	if (!(event instanceof SubmitEvent)) return
	if (typeof window === 'undefined') return
	if (event.defaultPrevented) return
	if (!(event.target instanceof HTMLFormElement)) return
	if (event.target.hasAttribute('data-router-skip')) return

	const submitter = getFormSubmitter(event)
	const details = resolveFormSubmitDetails(event.target, submitter)
	if (!details) return

	event.preventDefault()
	void submitFormThroughRouter(details)
}

function handlePopState() {
	// Hash-only history moves have no data to load — mirror forward hash-only
	// navigations (`commitImmediateNavigation`) and sync the UI immediately
	// instead of running the loader.
	if (getCurrentDocumentPath() === lastNotifiedDocumentPath) {
		cancelHoverIntent()
		// A pending loader navigation must not commit after this immediate
		// one and clobber the URL the browser already restored.
		navigationAbortController?.abort()
		navigationAbortController = null
		dispatchNavigationStart({ historyAction: 'pop' })
		notify()
		dispatchNavigationEnd(
			createNavigationEventDetail(getCurrentPathWithSearchAndHash(), {
				historyAction: 'pop',
			}),
		)
		return
	}
	void runNavigationWithLoader(new URL(window.location.href), {
		historyAction: 'pop',
		skipPushState: true,
	})
}

function ensureRouter() {
	if (typeof document === 'undefined') return
	if (routerInitialized) return
	routerInitialized = true
	ensureCurrentScrollRestorationKey()
	lastNotifiedDocumentPath = getCurrentDocumentPath()
	window.addEventListener('popstate', handlePopState)
	document.addEventListener('click', handleDocumentClick)
	document.addEventListener('submit', handleDocumentSubmit)
	document.addEventListener('mouseover', handleIntentHoverStart)
	document.addEventListener('mouseout', handleIntentHoverEnd)
	document.addEventListener('focusin', handleImmediateIntent)
	document.addEventListener('touchstart', handleImmediateIntent, {
		passive: true,
	})
}

export function listenToRouterNavigation(
	handle: Pick<Handle, 'signal' | 'update'>,
	listener: () => void,
) {
	if (typeof document === 'undefined') return
	ensureRouter()
	addEventListeners(routerEvents, handle.signal, {
		navigate: () => listener(),
	})
}

/**
 * Fires after the router submits a non-GET form (a mutation, e.g. logout).
 * Listeners that cache or throttle server-derived state must revalidate:
 * the follow-up redirect is a SPA navigation, so nothing else re-fetches
 * state the mutation may have changed.
 */
export function listenToRouterMutations(
	handle: Pick<Handle, 'signal' | 'update'>,
	listener: () => void,
) {
	if (typeof document === 'undefined') return
	ensureRouter()
	addEventListeners(routerEvents, handle.signal, {
		mutation: () => listener(),
	})
}

export function getPathname(handle?: Pick<Handle, 'context'>) {
	if (handle) {
		try {
			return readRouterPathname(handle as Handle)
		} catch {
			// Router location context is unavailable outside the app tree.
		}
	}
	if (typeof window === 'undefined') return '/'
	return window.location.pathname
}

async function navigateInternal(to: string, options?: NavigationRunOptions) {
	const destination = new URL(to, window.location.href)
	if (destination.origin !== window.location.origin) {
		window.location.assign(destination.toString())
		return
	}

	const current = new URL(window.location.href)
	const nextPath = getPathWithSearchAndHashFromUrl(destination)
	const currentPath = getCurrentPathWithSearchAndHash()

	if (nextPath === currentPath) return

	const sameDocumentLocation =
		`${destination.pathname}${destination.search}` ===
		`${current.pathname}${current.search}`
	if (sameDocumentLocation && destination.hash !== current.hash) {
		commitImmediateNavigation(nextPath, options)
		return
	}

	await runNavigationWithLoader(destination, options)
}

export function navigate(to: string, options?: RouterNavigateOptions): void {
	if (typeof window === 'undefined') return
	void navigateInternal(to, options).catch(() => {
		// Fire-and-forget: existing callers must not observe rejections.
	})
}

type RouterHandle = Pick<Handle, 'signal' | 'update' | 'context'> & {
	props: RouterSetup
}

export function Router(handle: RouterHandle) {
	if (typeof document !== 'undefined') {
		listenToRouterNavigation(handle, () => {
			void handle.update()
		})
	}

	return () => {
		// The server's 404 verdict only applies to the URL it rendered;
		// after SPA navigation, match routes normally again.
		if (handle.props.notFound && isOnSsrUrl(handle)) {
			return handle.props.fallback ?? null
		}

		const path = readRouterPathname(handle)
		const routeElement = matchRoute(path, handle.props.routes)
		if (routeElement) return routeElement
		return handle.props.fallback ?? null
	}
}

function normalizeHref(href: string) {
	const url = new URL(href, clientRouteOrigin)
	return `${url.pathname}${url.search}${url.hash}`
}

function isOnSsrUrl(handle: Pick<Handle, 'context'>) {
	return (
		normalizeHref(readRouterUrl(handle)) ===
		normalizeHref(readSsrRouterUrl(handle))
	)
}

export function readCurrentRouterHref(handle: Handle) {
	return readRouterUrl(handle)
}
