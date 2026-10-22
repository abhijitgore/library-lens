// Runs only in the request tab after an explicit Paste click.
// Fixed bibliographic fields only; no personal/account fields or submission.
export async function pasteBookDetails(libraryId, book) {
  const allowed = {
    spl: { origin: 'https://www.spl.org', path: /^\/books-and-media\/suggest-a-title\/?$/ },
    kcls: { origin: 'https://evgcatalog.kcls.org', path: /^\/patron-ui\/en\/requests\/create\/?$/ }
  };
  const site = allowed[libraryId];
  if (!site || location.origin !== site.origin || !site.path.test(location.pathname)) return { ok: false, message: 'Open this library’s official request form before pasting.' };
  const text = (value, limit = 300) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
  const norm = value => text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  const visible = el => el && !el.disabled && !el.readOnly && el.getClientRects().length > 0 && !el.closest('[hidden], [aria-hidden="true"]');
  const editable = el => visible(el) && (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && ['text', 'number', 'search', ''].includes(el.type || '')));
  const languageRaw = text(book.language, 80);
  const language = ({ en: 'English', eng: 'English', 'en-us': 'English', 'en-gb': 'English', es: 'Spanish', spa: 'Spanish', fr: 'French', fra: 'French', fre: 'French', de: 'German', deu: 'German', ger: 'German', zh: 'Chinese', zho: 'Chinese', chi: 'Chinese' })[languageRaw.toLowerCase()] || languageRaw;
  const date = text(book.publicationDate, 40);
  const year = date.match(/\b(?:18|19|20|21)\d{2}\b/)?.[0] || '';
  const notes = [
    book.format && `Requested format: ${text(book.format, 80)}`,
    libraryId === 'spl' && book.publisher && `Publisher: ${text(book.publisher)}`,
    libraryId === 'spl' && language && `Language: ${language}`,
    book.edition && `Edition: ${text(book.edition)}`,
    libraryId === 'kcls' && date && date !== year && `Publication date: ${date}`
  ].filter(Boolean).join('\n');
  const values = { title: text(book.title), author: text(book.author), isbn: text(book.isbn, 40), publisher: text(book.publisher), publicationDate: date, year, notes };
  let getField;
  let scope;
  if (libraryId === 'spl') {
    scope = document.querySelector('form#s-la-askform-form_17516');
    const selectors = { title: '#pquestion_17516[name="pquestion"]', author: '#custom7_17516[name="custom7"]', isbn: '#custom2_17516[name="custom2"]', publicationDate: '#custom8_17516[name="custom8"]', notes: '#pdetails_17516[name="pdetails"]' };
    getField = key => scope?.querySelector(selectors[key]);
  } else {
    scope = document.querySelector('app-patron-request-create');
    const labels = { title: 'Title', author: 'Author, Creator, Performer', isbn: 'ISBN, ISSN, UPC, OCLC Number', year: 'Publication Year', publisher: 'Publisher', notes: 'Other Notes and Comments' };
    getField = key => [...(scope?.querySelectorAll('mat-form-field') || [])].find(wrapper => text(wrapper.querySelector('mat-label')?.textContent).replace(/\s*\*$/, '') === labels[key])?.querySelector('input, textarea');
  }
  const fields = [];
  const missing = [];
  const keys = libraryId === 'spl' ? ['title', 'author', 'publicationDate', 'notes', 'isbn'] : ['title', 'author', 'year', 'publisher', 'notes', 'isbn'];
  for (const key of keys) {
    const value = values[key];
    if (!value) continue;
    const el = getField(key);
    const core = ['title', 'author', 'isbn'].includes(key);
    if (!editable(el)) {
      if (core) return { ok: false, message: libraryId === 'kcls' ? 'Sign in and choose a format, then retry.' : 'Form not ready. Retry or copy details.' };
      missing.push(key); continue;
    }
    if (el.value && el.value.trim() !== value) return { ok: false, message: 'A book field already contains different text. Nothing was changed. Clear that field or paste manually; the book stays in memory.' };
    if (el.maxLength >= 0 && value.length > el.maxLength) return { ok: false, message: 'These details are too long for a form field. Use Copy book details and review them manually.' };
    fields.push({ el, value });
  }
  if (!fields.length) return { ok: false, message: 'No book details to paste.' };
  for (const { el, value } of fields) {
    const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // ISBN is set last above because KCLS uses it for a duplicate-title check.
  const selectNative = (selector, wanted, label) => {
    if (!wanted) return;
    const el = scope?.querySelector(selector);
    if (!(el instanceof HTMLSelectElement) || !visible(el)) { missing.push(label); return; }
    const option = [...el.options].find(option => norm(option.textContent) === norm(wanted));
    if (!option) { missing.push(label); return; }
    const current = el.selectedOptions[0];
    if (el.value && current && norm(current.textContent) !== norm(wanted)) { missing.push(`${label} (existing choice kept)`); return; }
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, option.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (el.value !== option.value) missing.push(label);
  };
  const selectMaterial = async (label, wanted, aliases = []) => {
    if (!wanted) return;
    const wrapper = [...(scope?.querySelectorAll('mat-form-field') || [])].find(el => text(el.querySelector('mat-label')?.textContent) === label);
    const el = wrapper?.querySelector('mat-select');
    if (!visible(el) || el.getAttribute('aria-disabled') === 'true') { missing.push(label); return; }
    const selected = text(el.querySelector('.mat-mdc-select-value-text, .mat-select-value-text')?.textContent);
    const matches = value => [wanted, ...aliases].some(choice => norm(choice) === norm(value));
    if (selected && matches(selected)) return;
    if (selected) { missing.push(`${label} (existing choice kept)`); return; }
    el.click();
    let option;
    for (let attempt = 0; attempt < 20; attempt++) {
      const panelId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      const panel = panelId ? document.getElementById(panelId) : document;
      option = [...(panel?.querySelectorAll('mat-option[role="option"], .mat-mdc-option[role="option"]') || [])].find(option => visible(option) && option.getAttribute('aria-disabled') !== 'true' && matches(option.textContent));
      if (option) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (option) {
      option.click();
      for (let attempt = 0; attempt < 20; attempt++) {
        if (matches(el.querySelector('.mat-mdc-select-value-text, .mat-select-value-text')?.textContent)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      missing.push(label); return;
    }
    // Close the dropdown only. Do not touch the form's other choices.
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    missing.push(label);
  };
  if (libraryId === 'spl') {
    selectNative('#custom5_17516[name="custom5"]', book.format === 'Print book' ? 'Book' : text(book.format), 'Format');
    selectNative('#custom9_17516[name="custom9"]', text(book.audience), 'Audience');
    selectNative('#custom3_17516[name="custom3"]', text(book.category), 'Fiction / nonfiction');
  } else {
    // Format is chosen before the KCLS fields appear. Never change that choice here.
    await selectMaterial('Select a Language', language);
    const audience = text(book.audience);
    const aliases = ({ Adults: ['Adult'], Teens: ['Teen', 'Young Adult'], Kids: ['Children', 'Child', 'Juvenile'] })[audience] || [];
    await selectMaterial('Select an Audience', audience, aliases);
  }
  if (!fields.every(({ el, value }) => el.value === value)) return { ok: false, message: 'The form changed some pasted details. The book is still in memory; review the form or paste manually.' };
  fields[0].el.focus();
  if (missing.length) return { ok: false, partial: true, message: `Pasted available book details. Please review: ${missing.join(', ')}. The book is still in memory; you can finish manually and choose Forget book.` };
  return { ok: true, message: 'Book details pasted. Review the form and submit it yourself.' };
}

export function isRequestPage(libraryId, url) {
  try {
    const parsed = new URL(url);
    return libraryId === 'spl' ? parsed.origin === 'https://www.spl.org' && /^\/books-and-media\/suggest-a-title\/?$/.test(parsed.pathname) :
      libraryId === 'kcls' && parsed.origin === 'https://evgcatalog.kcls.org' && /^\/patron-ui\/en\/requests\/create\/?$/.test(parsed.pathname);
  } catch { return false; }
}
