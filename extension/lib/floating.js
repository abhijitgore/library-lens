// Installed only in the request tab opened by Request purchase.
export function installRequestHelper(entryId, libraryId) {
  const allowed = libraryId === 'kcls'
    ? location.origin === 'https://evgcatalog.kcls.org' && /^\/patron-ui\/en\/requests\/create\/?$/.test(location.pathname)
    : libraryId === 'spl' && location.origin === 'https://www.spl.org' && /^\/books-and-media\/suggest-a-title\/?$/.test(location.pathname);
  if (!allowed) return;
  const id = 'library-lens-request-helper';
  globalThis.__libraryLensRemoveHelper?.();
  document.getElementById(id)?.remove();
  const host = document.createElement('div');
  host.id = id;
  host.style.cssText = 'position:fixed;z-index:2147483647;width:108px;left:12px;top:45vh;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ':host{font:11px/1.3 system-ui;color:#203a2c}.box{box-sizing:border-box;background:#fff;border:1px solid #d1dfd4;border-radius:9px;box-shadow:0 3px 12px #0001;padding:7px}.brand{display:flex;align-items:center;gap:4px;margin-bottom:6px}.icon{display:grid;place-items:center;width:15px;height:15px;color:#236347;flex-shrink:0}.icon img{display:block;width:18px;height:18px;object-fit:contain}strong{font-size:9px;font-weight:650;white-space:nowrap}.badge{display:none}button{font:600 10px system-ui;border:0;border-radius:5px;padding:6px;cursor:pointer;background:#236347;color:white}button:focus-visible{outline:2px solid #b18735;outline-offset:2px}button:disabled{opacity:.6}.fill{width:100%;white-space:nowrap}.close{margin-left:auto;background:transparent;color:#6b7c71;padding:0;font-size:13px;line-height:14px}p{font-size:10px;margin:7px 0 0}p:empty{display:none}@media(prefers-color-scheme:dark){:host{color:#e5eee5}.box{background:#1c3025;border-color:#3b5143}.icon{color:#b9edca}.fill{background:#b9edca;color:#153e28}.close{color:#a0b5a6}}';
  const box = document.createElement('div'); box.className = 'box';
  const brand = document.createElement('div'); brand.className = 'brand';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true');
  const logo = document.createElement('img'); logo.src = chrome.runtime.getURL('icons/book-48.png'); logo.alt = '';
  icon.append(logo);
  const name = document.createElement('strong'); name.textContent = 'Library Lens';
  const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'Extension';
  const fill = document.createElement('button'); fill.className = 'fill'; fill.textContent = 'Fill details'; fill.setAttribute('aria-label', 'Fill book details'); fill.title = 'Library Lens — fill book details';
  const close = document.createElement('button'); close.className = 'close'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss Library Lens');
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  fill.addEventListener('click', async event => {
    if (!event.isTrusted) return;
    fill.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'FILL_REQUEST', entryId });
      if (result?.ok) {
        fill.textContent = 'Filled ✓'; status.textContent = '';
        setTimeout(() => cleanup(), 1600);
      } else { status.textContent = result?.message || 'Could not fill. Try again.'; fill.disabled = false; }
    } catch { status.textContent = 'Extension reloaded. Prepare the book again.'; fill.disabled = false; }
  });
  const onMessage = message => { if (message?.type === 'REMOVE_HELPER') cleanup(); };
  chrome.runtime.onMessage.addListener(onMessage);
  let placementFrame;
  let observer;
  const cleanup = () => {
    chrome.runtime.onMessage.removeListener(onMessage);
    observer?.disconnect();
    cancelAnimationFrame(placementFrame);
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    host.remove();
    if (globalThis.__libraryLensRemoveHelper === cleanup) delete globalThis.__libraryLensRemoveHelper;
  };
  globalThis.__libraryLensRemoveHelper = cleanup;
  close.addEventListener('click', cleanup);
  brand.append(icon, name, badge, close);
  box.append(brand, fill, status); shadow.append(style, box);
  const place = () => {
    const scope = document.querySelector('app-patron-request-create');
    const labels = ['Title', 'Author, Creator, Performer', 'ISBN, ISSN, UPC, OCLC Number'];
    const kclsField = [...(scope?.querySelectorAll('mat-form-field') || [])].find(field => {
      const label = (field.querySelector('mat-label')?.textContent || '').replace(/\s*\*$/, '').trim();
      return labels.includes(label) && field.getClientRects().length > 0 && getComputedStyle(field).visibility !== 'hidden';
    });
    const splField = document.querySelector('form#s-la-askform-form_17516 #pquestion_17516');
    const first = libraryId === 'kcls' ? kclsField : splField;
    const bounds = first?.getClientRects().length ? first.getBoundingClientRect() : null;
    const rect = bounds && bounds.bottom > 0 && bounds.top < innerHeight ? bounds : null;
    host.hidden = false;
    host.style.display = 'block';
    const pillWidth = 108;
    const gap = 8;
    host.dataset.mode = 'compact';
    box.classList.remove('rail');
    fill.textContent = 'Fill details';
    host.title = 'Library Lens extension';
    host.style.width = `${pillWidth}px`;
    if (!rect) {
      host.dataset.anchor = 'waiting';
      host.style.left = '12px'; host.style.top = `${Math.max(12, innerHeight / 2 - 32)}px`;
    } else if (rect.right + gap + pillWidth <= innerWidth) {
      host.dataset.anchor = 'field-right';
      host.style.left = `${rect.right + gap}px`;
      host.style.top = `${Math.max(8, Math.min(innerHeight - 84, rect.top + 5))}px`;
    } else {
      // If the right gutter is too narrow, float above the field rather than
      // covering it or placing the helper on the opposite side.
      host.dataset.anchor = 'above-field';
      host.style.left = `${Math.max(4, Math.min(innerWidth - pillWidth - 4, rect.left))}px`;
      const top = rect.top - host.getBoundingClientRect().height - 8;
      host.style.top = `${Math.max(4, top)}px`;
      if (top < 4) { host.hidden = true; host.style.display = 'none'; host.dataset.anchor = 'no-gutter'; }
    }
  };
  const schedule = () => { cancelAnimationFrame(placementFrame); placementFrame = requestAnimationFrame(place); };
  document.documentElement.append(host);
  place();
  observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('resize', schedule, { passive: true });
}
