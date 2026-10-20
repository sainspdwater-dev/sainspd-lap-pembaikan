(function () {
  if (!window.sainsDesktop) return;
  const queueKey = 'sainsDesktopDraftQueue';
  const getQueue = () => { try { return JSON.parse(localStorage.getItem(queueKey) || '[]'); } catch { return []; } };
  const keyOf = row => String(row?.['NO ADUAN'] || row?.noAduan || '').trim();
  const snapshot = row => JSON.stringify(Object.fromEntries(Object.entries(row || {}).filter(([key]) => !key.startsWith('_')).sort(([a], [b]) => a.localeCompare(b))));
  const isOfflineSession = () => localStorage.getItem('sainsDesktopOffline') === 'true' || !navigator.onLine || !localStorage.getItem('sainsToken');
  const postponed = new Set();
  let syncing = false;
  let lastAutomaticRefresh = Date.now();
  let lastAutomaticSync = 0;
  let automaticRefreshPending = false;
  const safeValue = value => value == null || value === '' ? '— kosong —' : String(value);
  const sameValue = (a, b) => safeValue(a).trim() === safeValue(b).trim();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function displayDraft(draft, serverRow = {}) {
    const row = { ...serverRow, ...draft.data, _desktopDraft: true };
    const dateText = row['TARIKH & MASA TERIMA  ADUAN'] || row['TARIKH TERIMA'];
    const date = typeof parseCustomDate === 'function' ? parseCustomDate(dateText) : new Date(dateText);
    if (dateText && Number.isFinite(date.getTime()) && date.getFullYear() >= 2000) {
      row.BULAN = `${monthNames[date.getMonth()]}-${String(date.getFullYear()).slice(-2)}`;
    }
    return row;
  }

  window.sainsDesktopOverlayDrafts = rows => {
    for (const draft of getQueue()) {
      if (draft.action !== 'addData' && draft.action !== 'updateData') continue;
      const index = rows.findIndex(row => keyOf(row) === draft.noAduan);
      if (index < 0) rows.unshift(displayDraft(draft));
      else rows[index] = displayDraft(draft, rows[index]);
    }
    return rows;
  };

  function changedFields(draft, current) {
    const fields = new Set([...Object.keys(draft.data || {}), ...Object.keys(draft.base || {}), ...Object.keys(current || {})]);
    fields.delete('_desktopDraft');
    return [...fields].filter(field => !sameValue(draft.base?.[field], current?.[field]) ||
      (draft.action === 'addData' && !sameValue(draft.data?.[field], current?.[field])));
  }

  function conflictSignature(draft, current) { return `${draft.noAduan}|${snapshot(draft.data)}|${snapshot(current)}`; }

  function showConflict(draft, current, duplicateCount) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.id = 'desktop-sync-conflict';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Konflik penyelarasan rekod');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:100100;background:#0f172acc;display:grid;place-items:center;padding:18px';
      const panel = document.createElement('div');
      panel.style.cssText = 'background:white;color:#172554;border-radius:12px;padding:20px;width:min(900px,100%);max-height:85vh;overflow:auto;font:14px system-ui;box-shadow:0 12px 36px #0005';
      const title = document.createElement('h2');
      title.textContent = `Konflik NO ADUAN ${draft.noAduan}`;
      const explanation = document.createElement('p');
      explanation.textContent = duplicateCount > 1
        ? `${duplicateCount} rekod pelayan mempunyai nombor aduan ini. Overwrite tidak selamat; hubungi pentadbir untuk nyahpendua.`
        : duplicateCount === 0
          ? 'Rekod ini tiada lagi di pelayan. Overwrite tidak tersedia; draf kekal pada komputer untuk semakan pentadbir.'
        : draft.action === 'addData'
          ? 'Nombor aduan ini sudah wujud di pelayan. Bandingkan data sebelum memilih Ya untuk kemas kini rekod sedia ada, bukan tambah rekod kedua.'
          : 'Rekod pelayan berubah selepas draf disimpan. Bandingkan nilai pelayan dan draf setempat sebelum memilih overwrite.';
      const tableWrap = document.createElement('div');
      tableWrap.style.cssText = 'overflow:auto;max-height:48vh';
      const table = document.createElement('table');
      table.style.cssText = 'border-collapse:collapse;width:100%;min-width:600px';
      const heading = document.createElement('tr');
      for (const label of ['Medan', 'Sebelum offline', 'Di pelayan sekarang', 'Draf komputer']) {
        const cell = document.createElement('th'); cell.textContent = label; cell.style.cssText = 'text-align:left;border-bottom:2px solid #cbd5e1;padding:7px'; heading.appendChild(cell);
      }
      table.appendChild(heading);
      for (const field of changedFields(draft, current)) {
        const row = document.createElement('tr');
        for (const value of [field, safeValue(draft.base?.[field]), safeValue(current?.[field]), safeValue(draft.data?.[field])]) {
          const cell = document.createElement('td'); cell.textContent = value; cell.style.cssText = 'padding:7px;border-bottom:1px solid #e2e8f0;word-break:break-word'; row.appendChild(cell);
        }
        table.appendChild(row);
      }
      tableWrap.appendChild(table);
      const warning = document.createElement('p');
      warning.textContent = 'Ya akan menghantar nilai draf bagi medan yang diisi dan boleh menggantikan nilai pelayan. Tidak mengekalkan draf setempat tanpa menghantar.';
      const yes = document.createElement('button'); yes.type = 'button'; yes.textContent = 'Ya, overwrite rekod pelayan';
      const no = document.createElement('button'); no.type = 'button'; no.textContent = 'Tidak, kekalkan draf';
      for (const button of [yes, no]) button.style.cssText = 'padding:9px 14px;margin:4px;border-radius:6px;border:1px solid #94a3b8;cursor:pointer';
      yes.style.background = '#dc2626'; yes.style.color = '#fff'; yes.disabled = duplicateCount !== 1;
      const finish = decision => { overlay.remove(); resolve(decision); };
      yes.addEventListener('click', () => finish(true)); no.addEventListener('click', () => finish(false));
      panel.append(title, explanation, tableWrap, warning, yes, no); overlay.appendChild(panel); document.body.appendChild(overlay); no.focus();
    });
  }

  function renderStatus(message = '') {
    const box = document.getElementById('desktop-offline-status');
    if (!box) return;
    const count = getQueue().length;
    const last = localStorage.getItem('sainsLastSync');
    const date = last ? new Date(last).toLocaleString('ms-MY') : 'belum pernah diselaraskan';
    const offline = isOfflineSession();
    box.querySelector('[data-role="label"]').textContent = offline ? 'OFFLINE' : 'ONLINE';
    box.querySelector('[data-role="toggle"]').style.background = offline ? '#b45309' : '#047857';
    box.querySelector('[data-role="toggle"]').title = `Data terakhir: ${date}; ${count} draf belum dihantar. Klik untuk butiran.`;
    box.querySelector('[data-role="details"]').textContent = `Data terakhir: ${date} · ${count} draf belum dihantar${message ? ` · ${message}` : ''}`;
    box.querySelector('[data-role="sync"]').disabled = count === 0 || isOfflineSession();
    box.querySelector('[data-role="login"]').hidden = !offline;
    const aiWarning = document.getElementById('desktop-ai-offline-warning');
    if (aiWarning) aiWarning.hidden = !isOfflineSession();
    const aiSend = document.getElementById('ai-send-btn');
    if (aiSend) aiSend.disabled = isOfflineSession();
  }

  function saveDraft(action, data, base, noAduan) {
    const queue = getQueue();
    const existing = queue.find(item => item.noAduan === noAduan);
    if (existing) {
      if (existing.action === 'addData' && action === 'updateData') existing.data = data;
      else if (existing.action === 'updateData' && action === 'updateData') existing.data = data;
      else throw new Error('Draf untuk rekod ini sudah ada. Semak draf dahulu.');
      existing.updatedAt = new Date().toISOString();
    } else queue.push({ action, data, base, noAduan, createdAt: new Date().toISOString() });
    localStorage.setItem(queueKey, JSON.stringify(queue));
  }

  function applyLocalDraft(action, data, noAduan) {
    const index = rawData.findIndex(row => keyOf(row) === noAduan);
    const draft = { data };
    if (index < 0) rawData.unshift(displayDraft(draft));
    else rawData[index] = displayDraft(draft, rawData[index]);
    localStorage.setItem('sainsRawData', JSON.stringify(rawData));
    window.sainsDesktopStore?.save().catch(console.warn);
    filteredData = [...rawData];
    try { populateFilters(); } catch (error) { console.warn('Penapis belum sedia; draf tetap disimpan.', error); }
    updateManagementTable(); updateCroTable(); closeModals();
    try { applyFilters(); } catch (error) { console.warn('Carta tidak dapat dikemas kini; draf dan jadual tetap tersedia.', error); }
  }

  window.sendDesktopMutation = async function (actionType, payloadData) {
    if (actionType === 'deleteData' && isOfflineSession()) {
      showToast('Padam rekod tidak dibenarkan offline. Sambung dan log masuk online dahulu.', 'error');
      return;
    }
    const noAduan = String(payloadData._oldNoAduan || payloadData['NO ADUAN'] || payloadData.noAduan || '').trim();
    if (!isOfflineSession() && getQueue().some(item => item.noAduan === noAduan)) {
      showToast('Rekod ini mempunyai draf offline. Semak draf dahulu sebelum ubah secara online.', 'error');
      return;
    }
    const clean = { ...payloadData };
    delete clean._oldNoAduan;
    const base = rawData.find(row => keyOf(row) === noAduan);

    if (isOfflineSession()) {
      if (actionType !== 'addData' && actionType !== 'updateData') return;
      if (!noAduan) { showToast('NO ADUAN wajib untuk draf offline.', 'error'); return; }
      try {
        saveDraft(actionType, clean, base || null, noAduan);
        applyLocalDraft(actionType, clean, noAduan);
        renderStatus();
        showToast('Disimpan sebagai draf pada komputer ini. Belum dihantar ke pelayan.');
      } catch (error) { showToast(`Draf tidak disimpan: ${error.message}`, 'error'); }
      return;
    }

    try {
      let action = actionType;
      if (actionType === 'addData' || actionType === 'updateData') {
        const rows = await serverRows();
        const matches = rows.filter(row => keyOf(row) === noAduan);
        const current = matches[0];
        const conflict = actionType === 'addData' ? matches.length > 0 :
          !current || Object.keys(clean).some(field => !sameValue(current[field], base?.[field]));
        if (conflict) {
          const accepted = await showConflict({ action: actionType, data: clean, base, noAduan }, current, matches.length);
          if (!accepted) return;
          const latest = (await serverRows()).filter(row => keyOf(row) === noAduan);
          if (latest.length !== 1 || snapshot(latest[0]) !== snapshot(current)) {
            showToast('Rekod pelayan berubah lagi. Buka semula borang untuk semakan.', 'error'); return;
          }
          action = 'updateData';
        }
      }
      const response = await fetch(WORKER_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('sainsToken')}` },
        body: JSON.stringify({ action, data: clean, noAduan }), signal: AbortSignal.timeout(20000)
      });
      if (response.status === 401) { showToast('Sesi online tamat. Log masuk online semula.', 'error'); return; }
      const result = await response.json();
      if (!response.ok || result.status !== 'success') throw new Error(result.message || `Pelayan menolak perubahan (${response.status}).`);
      closeModals();
      showToast('Disimpan pada pelayan.');
      await fetchFreshData(false);
    } catch (error) {
      if (error.name === 'TypeError' || error.name === 'TimeoutError') {
        try { saveDraft(actionType, clean, base || null, noAduan); applyLocalDraft(actionType, clean, noAduan); renderStatus(); showToast('Rangkaian terputus. Perubahan disimpan sebagai draf; semak sebelum hantar.', 'error'); }
        catch (saveError) { showToast(`Draf tidak disimpan: ${saveError.message}`, 'error'); }
      } else showToast(`Pelayan menolak perubahan: ${error.message}`, 'error');
    }
  };

  async function serverRows() {
    const response = await fetch(`${WORKER_URL}?fetch=all&t=${Date.now()}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('sainsToken')}` }, signal: AbortSignal.timeout(20000)
    });
    if (response.status === 401) throw new Error('Sesi online tamat. Log masuk semula.');
    if (!response.ok) throw new Error(`Tidak dapat membaca rekod pelayan (${response.status}).`);
    const result = await response.json();
    return Array.isArray(result) ? result : result.rawData || [];
  }

  async function syncDrafts(manual = false) {
    if (syncing || isOfflineSession()) { if (manual && isOfflineSession()) showToast('Log masuk online dahulu untuk menyelaras.', 'error'); return; }
    const drafts = getQueue();
    if (!drafts.length) { if (manual) await fetchFreshData(true); return; }
    syncing = true;
    renderStatus('menyemak draf dengan pelayan');
    let uploaded = 0;
    try {
      for (const draft of drafts) {
        if (isOfflineSession()) break;
        try {
          let rows = await serverRows();
          let matches = rows.filter(row => keyOf(row) === draft.noAduan);
          let current = matches[0];
          if (draft.action === 'updateData' && matches.length === 1 && Object.keys(draft.data || {}).every(field => sameValue(current[field], draft.data[field]))) {
            const remaining = getQueue().filter(item => item.noAduan !== draft.noAduan || snapshot(item.data) !== snapshot(draft.data));
            localStorage.setItem(queueKey, JSON.stringify(remaining));
            window.sainsDesktopStore?.save().catch(console.warn);
            continue; // A previous uncertain write already reached the server.
          }
          const changed = draft.action === 'addData' ? matches.length > 0 :
            !current || Object.keys(draft.data || {}).some(field => !sameValue(current[field], draft.base?.[field]));
          let action = draft.action;
          if (changed) {
            const signature = conflictSignature(draft, current);
            if (!manual && postponed.has(signature)) continue;
            const overwrite = await showConflict(draft, current, matches.length);
            if (!overwrite) { postponed.add(signature); renderStatus('konflik menunggu semakan'); continue; }
            // Re-read immediately before writing; a changed server copy needs a new decision.
            rows = await serverRows();
            matches = rows.filter(row => keyOf(row) === draft.noAduan);
            if (matches.length !== 1 || snapshot(matches[0]) !== snapshot(current)) {
              renderStatus('rekod pelayan berubah lagi; semak semula');
              continue;
            }
            action = 'updateData'; // Never append a second row when the number already exists.
          }
          const queuedNow = getQueue().find(item => item.noAduan === draft.noAduan);
          if (!queuedNow || snapshot(queuedNow.data) !== snapshot(draft.data)) continue;
          const saved = await fetch(WORKER_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('sainsToken')}` },
            body: JSON.stringify({ action, data: draft.data, noAduan: draft.noAduan }), signal: AbortSignal.timeout(20000)
          });
          if (saved.status === 401) throw new Error('Sesi online tamat. Log masuk semula.');
          if (!saved.ok) throw new Error(`Simpanan ditolak (${saved.status}).`);
          const resultSaved = await saved.json();
          if (resultSaved.status !== 'success') throw new Error(resultSaved.message || 'Simpanan ditolak.');
          const remaining = getQueue().filter(item => item.noAduan !== draft.noAduan || snapshot(item.data) !== snapshot(draft.data));
          localStorage.setItem(queueKey, JSON.stringify(remaining));
          window.sainsDesktopStore?.save().catch(console.warn);
          uploaded++;
          renderStatus(`${draft.noAduan} berjaya dihantar`);
        } catch (error) {
          renderStatus(`${draft.noAduan} belum dihantar: ${error.message}`);
          if (manual) showToast(`Draf ${draft.noAduan}: ${error.message}`, 'error');
          break; // Do not retry an uncertain network write until the next server comparison.
        }
      }
      if (uploaded) await fetchFreshData(false);
    } finally { syncing = false; renderStatus(getQueue().length ? 'baki draf memerlukan semakan' : 'data terkini'); }
  }

  window.sainsDesktopAutoSync = () => syncDrafts(false);

  function refreshAutomatically(force = false) {
    if (isOfflineSession() || syncing || (document.hidden && !force)) return;
    const now = Date.now();
    if (getQueue().length) {
      if (!force && now - lastAutomaticSync < 60_000) return;
      lastAutomaticSync = now;
      window.sainsDesktopAutoSync().catch(error => console.warn('Penyelarasan automatik ditangguh.', error));
      return;
    }
    // Focus/alt-tab can fire repeatedly. Do not rebuild all tables, charts and maps on each return.
    if (automaticRefreshPending || (!force && now - lastAutomaticRefresh < 2 * 60_000)) return;
    lastAutomaticRefresh = now;
    automaticRefreshPending = true;
    Promise.resolve(fetchFreshData(false)).catch(error => console.warn('Segar automatik ditangguh.', error))
      .finally(() => { automaticRefreshPending = false; });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const box = document.createElement('div');
    box.id = 'desktop-offline-status';
    box.setAttribute('role', 'status');
    box.style.cssText = 'position:relative;flex-shrink:0;font:13px system-ui';
    box.innerHTML = '<button type="button" data-role="toggle" aria-expanded="false" aria-label="Status sambungan; klik untuk butiran" style="color:white;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer"><span data-role="label"></span></button><div data-role="menu" hidden style="position:absolute;top:calc(100% + 6px);right:0;z-index:10000;min-width:260px;max-width:340px;padding:12px;background:#172554;color:white;border-radius:8px;box-shadow:0 3px 12px #0005"><div data-role="details" style="margin-bottom:8px"></div><button type="button" data-role="sync" style="color:#fff;text-decoration:underline;margin-right:10px">Semak draf</button><button type="button" data-role="login" style="color:#fff;text-decoration:underline">Log masuk online</button></div>';
    const clock = document.getElementById('live-clock');
    if (clock) clock.before(box);
    else document.body.appendChild(box);
    box.querySelector('[data-role="toggle"]').addEventListener('click', () => {
      const menu = box.querySelector('[data-role="menu"]');
      menu.hidden = !menu.hidden;
      box.querySelector('[data-role="toggle"]').setAttribute('aria-expanded', String(!menu.hidden));
    });
    const aiPanel = document.getElementById('ai-agent-content');
    if (aiPanel) {
      const warning = document.createElement('p');
      warning.id = 'desktop-ai-offline-warning';
      warning.style.cssText = 'padding:12px;margin:8px 0;background:#fef3c7;border:1px solid #f59e0b;color:#78350f;border-radius:8px;font-weight:600';
      warning.textContent = 'MOD OFFLINE — Analisis AI, D1 dan simulasi EPANET memerlukan internet serta log masuk online. Paparan data setempat bukan keputusan AI terkini.';
      aiPanel.prepend(warning);
    }
    box.querySelector('[data-role="sync"]').addEventListener('click', () => syncDrafts(true));
    box.querySelector('[data-role="login"]').addEventListener('click', () => { localStorage.removeItem('sainsLoggedIn'); location.href = 'index.html'; });
    renderStatus();
    window.addEventListener('online', () => {
      renderStatus(isOfflineSession() ? 'Internet kembali; log masuk online untuk menyelaras' : 'Internet kembali; menyelaras');
      refreshAutomatically(true);
    });
    window.addEventListener('offline', () => renderStatus());
    document.addEventListener('visibilitychange', () => refreshAutomatically());
    setInterval(() => renderStatus(), 30000);
    setInterval(() => refreshAutomatically(), 5 * 60 * 1000);
    if (isOfflineSession()) {
      const ai = document.getElementById('nav-ai');
      if (ai) ai.title = 'Fungsi AI/EPANET memerlukan sambungan pelayan. Rekod setempat masih boleh dilihat.';
    }
  });
})();
