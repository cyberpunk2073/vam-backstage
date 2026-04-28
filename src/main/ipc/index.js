import { registerAppHandlers } from './app.js'
import { registerPackageHandlers } from './packages.js'
import { registerContentHandlers } from './contents.js'
import { registerScanHandlers } from './scanner.js'
import { registerSettingsHandlers } from './settings.js'
import { registerThumbnailHandlers } from './thumbnails.js'
import { registerHubHandlers } from './hub.js'
import { registerDownloadHandlers } from './downloads.js'
import { registerAvatarHandlers } from './avatars.js'
import { registerDevHandlers } from './dev.js'
import { registerShellHandlers } from './shell.js'
import { registerExtractHandlers } from './extract.js'
import { registerLabelHandlers } from './labels.js'

export function registerAllHandlers() {
  registerAppHandlers()
  registerShellHandlers()
  registerPackageHandlers()
  registerContentHandlers()
  registerScanHandlers()
  registerSettingsHandlers()
  registerThumbnailHandlers()
  registerHubHandlers()
  registerDownloadHandlers()
  registerAvatarHandlers()
  registerDevHandlers()
  registerExtractHandlers()
  registerLabelHandlers()
}
