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
  // Closed: page scripts cannot read or restyle the helper; clicks are still isTrusted-checked below.
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = ':host{font:11px/1.3 system-ui;color:#203a2c}.box{box-sizing:border-box;background:#fff;border:1px solid #d1dfd4;border-radius:9px;box-shadow:0 3px 12px #0001;padding:7px}.brand{display:flex;align-items:center;gap:4px;margin-bottom:6px}.icon{display:grid;place-items:center;width:15px;height:15px;color:#236347;flex-shrink:0}.icon img{display:block;width:18px;height:18px;object-fit:contain}strong{font-size:9px;font-weight:650;white-space:nowrap}.badge{display:none}button{font:600 10px system-ui;border:0;border-radius:5px;padding:6px;cursor:pointer;background:#236347;color:white}button:focus-visible{outline:2px solid #b18735;outline-offset:2px}button:disabled{opacity:.6}.fill{width:100%;white-space:nowrap}.close{margin-left:auto;background:transparent;color:#6b7c71;padding:0;font-size:13px;line-height:14px}p{font-size:10px;margin:7px 0 0}p:empty{display:none}@media(prefers-color-scheme:dark){:host{color:#e5eee5}.box{background:#1c3025;border-color:#3b5143}.icon{color:#b9edca}.fill{background:#b9edca;color:#153e28}.close{color:#a0b5a6}}';
  const box = document.createElement('div'); box.className = 'box';
  const brand = document.createElement('div'); brand.className = 'brand';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true');
  // Inline icon: no web_accessible_resources entry, so library pages cannot probe for the extension.
  const logo = document.createElement('img'); logo.src = 'data:image/png;base64,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'; logo.alt = '';
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
