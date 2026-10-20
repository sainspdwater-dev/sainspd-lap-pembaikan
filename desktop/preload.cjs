const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sainsDesktop', {
  offlineStatus: () => ipcRenderer.invoke('desktop:offline-status'),
  onlineLogin: (username, passwordHash) => ipcRenderer.invoke('desktop:online-login', { username, passwordHash }),
  registerOffline: passphrase => ipcRenderer.invoke('desktop:register-offline', passphrase),
  unlockOffline: passphrase => ipcRenderer.invoke('desktop:unlock-offline', passphrase),
  checkUpdate: force => ipcRenderer.invoke('desktop:check-update', force === true),
  openUpdate: () => ipcRenderer.invoke('desktop:open-update')
});
