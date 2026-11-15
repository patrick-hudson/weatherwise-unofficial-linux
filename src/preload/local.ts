/** Preload for the app's own local pages (settings, alert details, offline). */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('wwLocal', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch: unknown) => ipcRenderer.invoke('config:set', patch),
  getLocation: () => ipcRenderer.invoke('geo:get'),
  getMapCenter: () => ipcRenderer.invoke('map:center'),
  testAlert: () => ipcRenderer.invoke('alerts:test'),
  refreshAlerts: () => ipcRenderer.invoke('alerts:refresh'),
  getActiveAlerts: () => ipcRenderer.invoke('alerts:active'),
  getAlert: (id: string) => ipcRenderer.invoke('alerts:get', id),
  openMapAt: (lat: number, lon: number, zoom?: number) => ipcRenderer.invoke('map:open-at', lat, lon, zoom),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  retry: () => ipcRenderer.invoke('site:retry'),
  pickSoundFile: () => ipcRenderer.invoke('dialog:pick-sound'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  onConfigChanged: (cb: (c: unknown) => void) => ipcRenderer.on('config:changed', (_e, c) => cb(c)),
  onStatus: (cb: (s: unknown) => void) => ipcRenderer.on('status', (_e, s) => cb(s)),
});
