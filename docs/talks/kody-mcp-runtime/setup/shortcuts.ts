import  { type NavOperations, type ShortcutOptions } from '@slidev/types'
import { defineShortcutsSetup } from '@slidev/types'

export default defineShortcutsSetup(
	(_nav: NavOperations, base: ShortcutOptions[]) =>
		base.filter((shortcut) => shortcut.name !== 'toggle_dark'),
)
