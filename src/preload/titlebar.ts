/** Preload for the custom titlebar view. */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('wwTitlebar', {
  action: (name: string, at?: { x: number; y: number }) => ipcRenderer.send('tb:action', name, at),
  getState: () => ipcRenderer.invoke('tb:get-state'),
  onState: (cb: (s: unknown) => void) => ipcRenderer.on('tb:state', (_e, s) => cb(s)),
});
