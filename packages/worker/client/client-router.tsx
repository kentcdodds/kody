import { addEventListeners, type Handle } from 'remix/ui'
import { createMultiMatcher } from 'remix/route-pattern/match'
import { type AppLoaderData } from '#app/loader-data.ts'
import { setPreloadedNavigationData } from './navigation-data.ts'
import {
	readRouterPathname,
	readRouterUrl,
	readSsrRouterUrl,
} from './router-location.tsx'

export type RouteLoader = (
	url: URL,
	signal: AbortSignal,
) => Promise<Partial<AppLoaderData> | null>

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
}

type NavigationRunOptions = {
	/** Browser already changed the URL (popstate / same-path refresh). */
	skipPushState?: boolean
	/** Form POST already dispatched `navigationstart`; loader owns `navigationend`. */
	suppressStart?: boolean
}

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

function notify() {
	routerEvents.dispatchEvent(new Event('navigate'))
}

function dispatchNavigationStart() {
	routerEvents.dispatchEvent(new Event('navigationstart'))
}

function dispatchNavigationEnd() {
	routerEvents.dispatchEvent(new Event('navigationend'))
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
	navigate(`${destination.pathname}${destination.search}${destination.hash}`)
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
	window.history.pushState({}, '', nextPath)
	notify()
}

function commitImmediateNavigation(
	nextPath: string,
	options?: Pick<NavigationRunOptions, 'suppressStart'>,
) {
	// A pending loader navigation must not commit after this immediate one
	// and clobber the URL we are about to push.
	navigationAbortController?.abort()
	navigationAbortController = null
	if (!options?.suppressStart) {
		dispatchNavigationStart()
	}
	commitNavigation(nextPath)
	dispatchNavigationEnd()
}

async function runNavigationWithLoader(
	destination: URL,
	options?: NavigationRunOptions,
) {
	navigationAbortController?.abort()
	const abortController = new AbortController()
	navigationAbortController = abortController
	const { signal } = abortController

	if (!options?.suppressStart) {
		dispatchNavigationStart()
	}

	const nextPath = getPathWithSearchAndHashFromUrl(destination)
	const loader = matchRouteLoader(destination)

	try {
		let loadedData: Partial<AppLoaderData> | undefined
		if (loader) {
			const data = await loader(destination, signal)
			if (signal.aborted) return
			if (data === null) {
				dispatchNavigationEnd()
				return
			}
			loadedData = data
		}

		if (signal.aborted) return

		// Store and commit in the same synchronous block so a superseding
		// navigation can never leave consume-once data behind for a URL the
		// user did not land on.
		if (loadedData) {
			setPreloadedNavigationData(nextPath, loadedData)
		}

		if (options?.skipPushState) {
			notify()
		} else {
			commitNavigation(nextPath)
		}
		dispatchNavigationEnd()
	} catch {
		if (signal.aborted) return
		if (options?.skipPushState) {
			notify()
		} else {
			commitNavigation(nextPath)
		}
		dispatchNavigationEnd()
	}
}

async function navigateWithRefreshForSamePath(
	destination: URL,
	options?: Pick<NavigationRunOptions, 'suppressStart'>,
) {
	if (
		getPathWithSearchAndHashFromUrl(destination) ===
		getCurrentPathWithSearchAndHash()
	) {
		await runNavigationWithLoader(new URL(window.location.href), {
			skipPushState: true,
			suppressStart: options?.suppressStart,
		})
		return
	}
	await navigateInternal(destination.toString(), options)
}

async function submitFormThroughRouter(details: FormSubmitDetails) {
	if (details.method === 'get') {
		navigate(buildGetDestination(details.action, details.formData).toString())
		return
	}

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
	dispatchNavigationStart()

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
		if (signal.aborted) return

		if (response.redirected) {
			await navigateWithRefreshForSamePath(
				new URL(response.url, window.location.href),
				{ suppressStart: true },
			)
			return
		}

		const location = response.headers.get('Location')
		if (location) {
			await navigateWithRefreshForSamePath(new URL(location, details.action), {
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
		dispatchNavigationEnd()
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
	void runNavigationWithLoader(new URL(window.location.href), {
		skipPushState: true,
	})
}

function ensureRouter() {
	if (typeof document === 'undefined') return
	if (routerInitialized) return
	routerInitialized = true
	window.addEventListener('popstate', handlePopState)
	document.addEventListener('click', handleDocumentClick)
	document.addEventListener('submit', handleDocumentSubmit)
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

async function navigateInternal(
	to: string,
	options?: Pick<NavigationRunOptions, 'suppressStart'>,
) {
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

export function navigate(to: string): void {
	if (typeof window === 'undefined') return
	void navigateInternal(to).catch(() => {
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
