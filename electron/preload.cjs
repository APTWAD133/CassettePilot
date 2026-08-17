const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cassetteNative", {
  command: (command) => ipcRenderer.invoke("cassette-native:command", command),
  getState: () => ipcRenderer.invoke("cassette-native:get-state"),
  onEvent(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("cassette-native:event", listener);
    return () => ipcRenderer.removeListener("cassette-native:event", listener);
  }
});

contextBridge.exposeInMainWorld("cassetteStorage", {
  loadMixtapes: () => ipcRenderer.invoke("cassette-storage:load-mixtapes"),
  saveMixtapes: (value) => ipcRenderer.invoke("cassette-storage:save-mixtapes", value),
  loadSettings: () => ipcRenderer.invoke("cassette-storage:load-settings"),
  saveSettings: (value) => ipcRenderer.invoke("cassette-storage:save-settings", value),
  loadDiagnostics: () => ipcRenderer.invoke("cassette-storage:load-diagnostics"),
  saveDiagnostics: (value) => ipcRenderer.invoke("cassette-storage:save-diagnostics", value)
});
