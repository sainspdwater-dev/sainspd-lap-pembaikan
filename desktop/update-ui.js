(function () {
  if (!window.sainsDesktop?.checkUpdate) return;

  document.addEventListener('DOMContentLoaded', () => {
    const wrapper = document.createElement('div');
    wrapper.id = 'desktop-update-status';
    wrapper.style.cssText = 'position:relative;flex-shrink:0;font:13px system-ui;z-index:10001';
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.hidden = true;
    badge.style.cssText = 'background:#b45309;color:white;border:0;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer';
    const panel = document.createElement('div');
    panel.hidden = true;
    panel.style.cssText = 'position:absolute;top:calc(100% + 6px);right:0;z-index:10002;width:min(330px,85vw);padding:12px;background:#172554;color:white;border-radius:8px;box-shadow:0 3px 12px #0005;line-height:1.4';
    const message = document.createElement('p');
    message.style.marginBottom = '10px';
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Buka halaman kemas kini';
    open.style.cssText = 'background:#2563eb;color:white;padding:7px 9px;border:0;border-radius:6px;cursor:pointer';
    const later = document.createElement('button');
    later.type = 'button';
    later.textContent = 'Nanti';
    later.style.cssText = 'color:white;padding:7px 9px;margin-left:5px;border:1px solid #94a3b8;border-radius:6px;cursor:pointer';
    panel.append(message, open, later);
    wrapper.append(badge, panel);
    const clock = document.getElementById('live-clock');
    const loginCard = document.querySelector('.login-card');
    if (clock) clock.before(wrapper);
    else if (loginCard) {
      wrapper.style.cssText += ';text-align:right;margin-bottom:8px';
      loginCard.prepend(wrapper);
    } else return;

    badge.addEventListener('click', () => { panel.hidden = !panel.hidden; });
    later.addEventListener('click', () => { panel.hidden = true; });
    open.addEventListener('click', async () => {
      try { await window.sainsDesktop.openUpdate(); }
      catch { message.textContent = 'Pautan kemas kini tidak dapat dibuka. Semak versi semula.'; }
    });

    async function check(manual = false, force = false) {
      try {
        const result = await window.sainsDesktop.checkUpdate(manual || force);
        if (result.available) {
          badge.textContent = `Kemas kini v${result.version} tersedia`;
          badge.hidden = false;
          message.textContent = `Versi ${result.currentVersion} sedang digunakan. Installer v${result.version} sudah diterbitkan. Simpan dan selaraskan draf sebelum memasang. Buka halaman rasmi untuk muat turun; aplikasi tidak memasang sendiri.`;
          open.hidden = false;
          if (manual) panel.hidden = false;
        } else if (manual) {
          badge.textContent = 'Semakan versi desktop';
          badge.hidden = false;
          message.textContent = result.error || result.reason || `Versi ${result.currentVersion} ialah versi terkini yang diterbitkan.`;
          open.hidden = true;
          panel.hidden = false;
        }
      } catch {
        if (manual) {
          badge.textContent = 'Semakan versi desktop';
          badge.hidden = false;
          message.textContent = 'Tidak dapat menyemak kemas kini sekarang. Cuba lagi apabila internet tersedia.';
          open.hidden = true;
          panel.hidden = false;
        }
      }
    }

    const dashboardMenu = document.querySelector('#desktop-offline-status [data-role="menu"]');
    if (dashboardMenu) {
      const manual = document.createElement('button');
      manual.type = 'button';
      manual.textContent = 'Semak kemas kini';
      manual.style.cssText = 'color:white;text-decoration:underline;cursor:pointer;margin-top:8px';
      manual.addEventListener('click', () => check(true));
      dashboardMenu.appendChild(manual);
    } else if (loginCard) {
      const manual = document.createElement('button');
      manual.type = 'button';
      manual.textContent = 'Semak kemas kini';
      manual.style.cssText = 'display:block;background:none;border:0;color:#a0b3d9;text-decoration:underline;cursor:pointer;margin:10px auto 0';
      manual.addEventListener('click', () => check(true));
      loginCard.appendChild(manual);
    }
    check(false);
    window.addEventListener('online', () => check(false, true));
    setInterval(() => { if (navigator.onLine) check(false); }, 4 * 60 * 60_000);
  });
})();
