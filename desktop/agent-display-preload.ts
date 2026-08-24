import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld(
  "keAgentDisplays",
  Object.freeze({
    bootstrap: () => ipcRenderer.invoke("agent-display:bootstrap"),
    refresh: (sessionId: string | null) => ipcRenderer.invoke("agent-display:refresh", sessionId),
    takeControl: (sessionId: string) => ipcRenderer.invoke("agent-display:take-control", sessionId),
    returnControl: (sessionId: string) => ipcRenderer.invoke("agent-display:return-control", sessionId),
    stop: (sessionId: string) => ipcRenderer.invoke("agent-display:stop", sessionId),
    act: (sessionId: string, action: unknown) =>
      ipcRenderer.invoke("agent-display:human-act", sessionId, action),
  }),
);
