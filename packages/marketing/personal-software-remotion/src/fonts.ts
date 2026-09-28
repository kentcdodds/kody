import { loadFont } from '@remotion/fonts'
import { fontFiles } from './assets.ts'

export function loadBrandFonts() {
	return Promise.all([
		loadFont({
			family: 'Bricolage Grotesque',
			url: fontFiles.bricolageLatin,
			weight: '400 800',
			format: 'woff2',
		}),
		loadFont({
			family: 'Wix Madefor Text',
			url: fontFiles.wixLatin,
			weight: '400 800',
			format: 'woff2',
		}),
	])
}
