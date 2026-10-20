(function () {
  if (!window.sainsDesktop) return;
  const databaseName = 'sains-pd-desktop-v1';
  const keys = ['sainsRawData', 'sainsDropdowns', 'sainsLastSync', 'sainsDesktopDraftQueue'];
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function save() {
    const db = await open();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('snapshots', 'readwrite');
        transaction.objectStore('snapshots').put(Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), 'latest');
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }
  async function restore() {
    const db = await open();
    try {
      const snapshot = await new Promise((resolve, reject) => {
        const request = db.transaction('snapshots', 'readonly').objectStore('snapshots').get('latest');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!snapshot) return false;
      for (const key of keys) if (!localStorage.getItem(key) && snapshot[key] != null) localStorage.setItem(key, snapshot[key]);
      return !!localStorage.getItem('sainsRawData');
    } finally { db.close(); }
  }
  window.sainsDesktopStore = { save, restore };
})();
