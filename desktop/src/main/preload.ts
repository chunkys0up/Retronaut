/** The little the renderer needs from Electron: open links and System Settings panes, and the picture-in-picture's chip and Stop. */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('retronaut', {
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openPrivacy: (pane: 'accessibility' | 'screen') => ipcRenderer.invoke('open-privacy', pane),
  /** The engine wants the person to look at a workflow (a question, a card, a result). */
  onAttention: (listener: (workflowId: string) => void) => {
    const handler = (_event: unknown, workflowId: string) => listener(workflowId)
    ipcRenderer.on('attention', handler)
    return () => ipcRenderer.removeListener('attention', handler)
  },
  /** The picture-in-picture's activity chip's Stop button: stop the build or run. */
  stopLive: () => ipcRenderer.send('overlay-stop'),
  /** The pointer is over the picture-in-picture's activity chip (it stays, and takes clicks) or has left it. */
  pipChipHover: (over: boolean) => ipcRenderer.send('pip-chip-hover', over),
})
