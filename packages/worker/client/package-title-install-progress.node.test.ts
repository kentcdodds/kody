import { expect, test, vi } from 'vitest'
import {
	showPackageTitleInstallProgress,
	stopPackageTitleInstallProgress,
} from './package-title-install-progress.ts'

test('package title install progress names the live stage on the fork slot and restores it', () => {
	const icon = { hidden: false }
	const spinner = { hidden: true }
	const tooltip = { textContent: 'Fork' }
	const live = { textContent: '' }
	const attributes = new Map<string, string>([
		['data-package-title-status', 'verify'],
		['data-package-title-idle', 'verify'],
		['data-title-idle-label', 'Verify before using'],
		['data-title-idle-tooltip', 'Verify before using'],
	])
	const control = {
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
	vi.stubGlobal('document', {
		querySelector: () => control,
	})

	showPackageTitleInstallProgress('Bundling')
	expect(attributes.get('data-package-title-status')).toBe('progress')
	expect(attributes.get('aria-busy')).toBe('true')
	expect(attributes.get('aria-label')).toBe('Bundling')
	expect(icon.hidden).toBe(true)
	expect(spinner.hidden).toBe(false)
	expect(tooltip.textContent).toBe('Bundling')
	expect(live.textContent).toBe('Bundling')

	stopPackageTitleInstallProgress()
	expect(attributes.get('data-package-title-status')).toBe('verify')
	expect(attributes.has('aria-busy')).toBe(false)
	expect(attributes.get('aria-label')).toBe('Verify before using')
	expect(icon.hidden).toBe(false)
	expect(spinner.hidden).toBe(true)
	expect(tooltip.textContent).toBe('Verify before using')
	expect(live.textContent).toBe('')

	vi.unstubAllGlobals()
})
