/* Nova UI kit — the production layer every page shares.
   UI.api(url, opts)  fetch with 12s timeout, JSON parsing, normalized errors
   UI.busy(btn, fn)   disables the control + spinner while fn runs (no double-clicks)
   UI.toast(msg, bad) unified toast (reuses #toast if the page has one)
   Plus: offline banner, hover prefetch for instant page hops.            */
(function () {
  const UI = window.UI = {};

  /* ---- fetch that never hangs and always explains itself ---- */
  UI.api = async function (url, opts = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), opts.timeout || 12000);
    let r;
    try {
      r = await fetch(url, { ...opts, signal: ctl.signal });
    } catch (e) {
      clearTimeout(t);
      throw new Error(navigator.onLine === false
        ? 'You\'re offline — check your connection'
        : e.name === 'AbortError' ? 'Server is taking too long — try again' : 'Network error — try again');
    }
    clearTimeout(t);
    let d = {};
    try { d = await r.json(); } catch (e) {}
    if (!r.ok) { const err = new Error(d.error || ('Request failed (' + r.status + ')')); err.status = r.status; throw err; }
    return d;
  };

  /* ---- a button that visibly works while it works ---- */
  UI.busy = async function (btn, fn) {
    if (!btn || btn.classList.contains('busy')) return;
    btn.classList.add('busy');
    try { return await fn(); }
    finally { btn.classList.remove('busy'); }
  };

  /* ---- one toast to rule them all ---- */
  UI.toast = function (msg, bad) {
    let t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast'; t.className = 'toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(10px);background:rgba(22,22,26,.94);color:#f6f4ef;padding:12px 22px;border-radius:980px;font-size:14px;font-weight:500;opacity:0;transition:opacity .3s,transform .3s;pointer-events:none;z-index:400';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = bad ? 'rgba(170,45,30,.96)' : '';
    t.classList.add('show');
    if (!t.className.includes('toast')) t.style.opacity = 1;
    t.style.opacity = 1; t.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(UI._tt);
    UI._tt = setTimeout(() => {
      t.classList.remove('show');
      t.style.opacity = 0; t.style.transform = 'translateX(-50%) translateY(10px)';
    }, 2800);
  };

  /* ---- offline awareness, everywhere ---- */
  function netbar() {
    let b = document.getElementById('netbar');
    if (!b) {
      b = document.createElement('div');
      b.id = 'netbar'; b.className = 'netbar';
      b.textContent = '📡 You\'re offline — live data is paused';
      document.body.appendChild(b);
    }
    return b;
  }
  addEventListener('offline', () => netbar().classList.add('show'));
  addEventListener('online', () => { netbar().classList.remove('show'); UI.toast('Back online'); });
  if (navigator.onLine === false) setTimeout(() => netbar().classList.add('show'), 400);

  /* ---- hover prefetch: the next page is already warm ---- */
  const seen = new Set();
  document.addEventListener('pointerover', e => {
    const a = e.target.closest && e.target.closest('a[href$=".html"], a[href="/"]');
    if (!a || seen.has(a.href)) return;
    seen.add(a.href);
    const l = document.createElement('link');
    l.rel = 'prefetch'; l.href = a.href;
    document.head.appendChild(l);
  });
})();
