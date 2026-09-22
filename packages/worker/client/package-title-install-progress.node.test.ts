import { afterEach, expect, test, vi } from 'vitest'
import { installProgressWordHoldMs } from '#client/action-button-loader.tsx'
import {
	releasePackageTitleInstallProgress,
	showPackageTitleInstallProgress,
	startPackageTitleInstallProgress,
	stopPackageTitleInstallProgress,
} from './package-title-install-progress.ts'

afterEach(() => {
	stopPackageTitleInstallProgress({ restore: false })
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

function fakeControl(input: {
	status: 'fork' | 'verify'
	label: string
	listingId?: string
}) {
	const icon = { hidden: false }
	const spinner = { hidden: true }
	const tooltip = { textContent: input.label }
	const live = { textContent: '' }
	const attributes = new Map<string, string>([
		['data-package-title-status', input.status],
		['data-package-title-idle', input.status],
		['data-title-idle-label', input.label],
		['data-title-idle-tooltip', input.label],
		['aria-label', input.label],
	])
	if (input.listingId) {
		attributes.set('data-package-title-listing', input.listingId)
	}
	const control = {
		isConnected: true,
		getAttribute(name: string) {
			return attributes.get(name) ?? null
		},
		setAttribute(name: string, value: string) {
			attributes.set(name, value)
		},
		removeAttribute(name: string) {
			attributes.delete(name)
		},
		querySelector(selector: string) {
			if (selector === '[data-title-status-icon]') return icon
			if (selector === '[data-title-status-spinner]') return spinner
			if (selector === '[data-title-status-tooltip]') return tooltip
			if (selector === '[data-title-status-live]') return live
			return null
		},
	}
	return { control, attributes, icon, spinner, tooltip, live }
}

test('package title install progress names the live stage on the fork slot and restores it', () => {
	const slot = fakeControl({
		status: 'verify',
		label: 'Verify before using',
	})
	vi.stubGlobal('document', {
		querySelector: () => slot.control,
	})

	showPackageTitleInstallProgress('Bundling')
	expect(slot.attributes.get('data-package-title-status')).toBe('progress')
	expect(slot.attributes.get('aria-busy')).toBe('true')
	expect(slot.attributes.get('aria-label')).toBe('Bundling')
	expect(slot.icon.hidden).toBe(true)
	expect(slot.spinner.hidden).toBe(false)
	expect(slot.tooltip.textContent).toBe('Bundling')
	expect(slot.live.textContent).toBe('Bundling')

	stopPackageTitleInstallProgress()
	expect(slot.attributes.get('data-package-title-status')).toBe('verify')
	expect(slot.attributes.has('aria-busy')).toBe(false)
	expect(slot.attributes.get('aria-label')).toBe('Verify before using')
	expect(slot.icon.hidden).toBe(false)
	expect(slot.spinner.hidden).toBe(true)
	expect(slot.tooltip.textContent).toBe('Verify before using')
	expect(slot.live.textContent).toBe('')
})

test('install progress stays on the listing that started it', () => {
	vi.useFakeTimers()
	const origin = fakeControl({
		status: 'verify',
		label: 'Verify before using',
		listingId: 'listing-a',
	})
	const destination = fakeControl({
		status: 'fork',
		label: 'Fork',
		listingId: 'listing-b',
	})
	let current: typeof origin.control | typeof destination.control =
		origin.control
	vi.stubGlobal('document', {
		querySelector: () => current,
	})

	startPackageTitleInstallProgress(
		['Forking', 'Copying', 'Checking'],
		'listing-a',
	)
	expect(origin.attributes.get('aria-label')).toBe('Forking')
	expect(origin.spinner.hidden).toBe(false)

	current = destination.control
	vi.advanceTimersByTime(installProgressWordHoldMs)
	expect(origin.attributes.get('aria-label')).toBe('Copying')
	expect(destination.attributes.get('data-package-title-status')).toBe('fork')
	expect(destination.spinner.hidden).toBe(true)
	expect(destination.attributes.get('aria-label')).toBe('Fork')

	expect(releasePackageTitleInstallProgress('listing-b')).toBe(true)
	expect(origin.attributes.get('data-package-title-status')).toBe('verify')
	expect(origin.spinner.hidden).toBe(true)
	expect(destination.attributes.get('data-package-title-status')).toBe('fork')

	startPackageTitleInstallProgress(['Forking', 'Copying'], 'listing-b')
	expect(destination.attributes.get('aria-label')).toBe('Forking')
	expect(origin.attributes.get('data-package-title-status')).toBe('verify')

	stopPackageTitleInstallProgress({
		listingId: 'listing-a',
		restore: false,
	})
	vi.advanceTimersByTime(installProgressWordHoldMs)
	expect(destination.attributes.get('aria-label')).toBe('Copying')
	expect(destination.spinner.hidden).toBe(false)

	stopPackageTitleInstallProgress({ listingId: 'listing-b' })
	expect(destination.attributes.get('data-package-title-status')).toBe('fork')
	expect(destination.spinner.hidden).toBe(true)
})

test('a reused status control is not painted or restored for the previous listing', () => {
	vi.useFakeTimers()
	const slot = fakeControl({
		status: 'verify',
		label: 'Verify before using',
		listingId: 'listing-a',
	})
	vi.stubGlobal('document', {
		querySelector: () => slot.control,
	})
	startPackageTitleInstallProgress(['Forking', 'Copying'], 'listing-a')

	slot.attributes.set('data-package-title-listing', 'listing-b')
	slot.attributes.set('data-package-title-status', 'fork')
	slot.attributes.set('data-package-title-idle', 'fork')
	slot.attributes.set('aria-label', 'Fork')
	slot.spinner.hidden = true
	slot.icon.hidden = false

	vi.advanceTimersByTime(installProgressWordHoldMs)
	expect(slot.attributes.get('data-package-title-status')).toBe('fork')
	expect(slot.attributes.get('aria-label')).toBe('Fork')
	expect(slot.spinner.hidden).toBe(true)

	expect(releasePackageTitleInstallProgress(null)).toBe(false)
	expect(slot.attributes.get('aria-label')).toBe('Fork')
})
