import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld(
  "kePen",
  Object.freeze({
    bootstrap: () => ipcRenderer.invoke("pen:bootstrap"),
    beginStroke: () => ipcRenderer.sendSync("pen:begin-stroke"),
    releaseDisplay: () => ipcRenderer.invoke("pen:release-display"),
    submitAnnotation: (payload: unknown) => ipcRenderer.invoke("pen:submit-annotation", payload),
    cancel: () => ipcRenderer.send("pen:cancel"),
    onPhase: (callback: (phase: string) => void) => {
      ipcRenderer.on("pen:phase", (_event, phase: string) => callback(phase));
    },
  }),
);
