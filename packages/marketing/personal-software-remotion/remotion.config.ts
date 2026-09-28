import { Config } from '@remotion/cli/config'

Config.setVideoImageFormat('jpeg')
Config.setJpegQuality(95)
Config.setCodec('h264-mkv')
Config.setCrf(16)
Config.setX264Preset('slow')
Config.setPixelFormat('yuv420p')
Config.setColorSpace('bt709')
Config.setAudioCodec('pcm-16')
Config.setOverwriteOutput(true)
