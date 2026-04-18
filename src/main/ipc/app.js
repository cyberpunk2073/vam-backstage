import { ipcMain, app } from 'electron'

export function registerAppHandlers() {
  ipcMain.handle('app:version', () => app.getVersion())
}
