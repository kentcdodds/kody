import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'
import yogaWasm from 'satori/yoga.wasm'

export {
	ensureOgBinaryAssetsReady,
	getBricolageGrotesqueLatin700FontData,
	getKodyLanternBaseDataUri,
	getLandingAgentIconDataUri,
	getKodyDiscordDataUri,
	getKodyLogoDataUri,
	getKodyPatternDataUri,
	getWixMadeforTextLatin400FontData,
	resetOgBinaryAssetsCache,
	type OgAssetsFetcher,
} from './og-binary-assets.ts'

export const ogYogaWasm = yogaWasm
export const ogResvgWasm = resvgWasm
