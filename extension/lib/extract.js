// Self-contained: Chrome serializes this function into the isolated world of the clicked tab.
// It reads metadata once, installs no listeners, and makes no network requests.
export function extractBookCandidates() {
  const clean = (v, limit = 300) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
  const validIsbn = value => {
    const isbn = String(value ?? '').replace(/^ISBN(?:-1[03])?\s*:?\s*/i, '').replace(/[\s-]/g, '').toUpperCase();
    if (/^(978|979)\d{10}$/.test(isbn)) return [...isbn].reduce((s, n, i) => s + Number(n) * (i % 2 ? 3 : 1), 0) % 10 === 0 ? isbn : '';
    if (/^\d{9}[\dX]$/.test(isbn)) return [...isbn].reduce((s, n, i) => s + (n === 'X' ? 10 : Number(n)) * (10 - i), 0) % 11 === 0 ? isbn : '';
    return '';
  };
  const isbns = value => {
    const text = String(value ?? '').slice(0, 12000).replace(/\bISBN(?:-1[03])?\s*:?/gi, ' ');
    return [...text.matchAll(/(?<![\dXx])(?:97[89][\s-]?)?\d(?:[\s-]?\d){8}[\s-]?[\dXx](?![\dXx])/g)]
      .map(match => validIsbn(match[0])).filter(Boolean);
  };
  const list = value => Array.isArray(value) ? value : value == null ? [] : [value];
  const typeIs = (node, type) => list(node?.['@type']).some(t => typeof t === 'string' && t.split(/[\/#]/).pop() === type);
  const meta = names => {
    for (const name of names) {
      const value = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content');
      if (value) return clean(value);
    }
    return '';
  };
  const visible = node => node && !node.closest('[hidden], [aria-hidden="true"], form, input, textarea, select') && node.getClientRects().length > 0;
  const textOf = node => visible(node) ? clean(node.innerText || node.textContent, 300) : '';
  const candidates = [];
  const coverUrl = value => {
    try {
      const raw = typeof value === 'string' ? value : value?.url || value?.contentUrl || '';
      if (!raw.trim()) return '';
      const url = new URL(raw, location.href);
      // Block literal IPs and local hosts even if this helper is called outside
      // the popup's supported-source gate. URL normalizes alternate IP forms.
      if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) || url.hostname.startsWith('[') || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) return '';
      const cdns = ['m.media-amazon.com', 'images-na.ssl-images-amazon.com', 'images-eu.ssl-images-amazon.com'];
      const bnImage = location.hostname.replace(/^www\./, '') === 'barnesandnoble.com' && url.hostname === 'cdn.shopify.com' && url.pathname.startsWith('/s/files/1/0674/5433/7265/files/');
      // Fixed retailer image CDNs only (no retailer-origin images): the popup
      // loads covers with crossorigin="anonymous", so no retailer cookies ride along.
      return url.protocol === 'https:' && !url.username && !url.password && (cdns.includes(url.hostname) || bnImage) && url.href.length < 2000 ? url.href : '';
    } catch { return ''; }
  };
  const add = (book, source) => {
    const title = clean(book.title);
    const isbn = validIsbn(book.isbn);
    if (!title && !isbn) return;
    const author = clean(book.author);
    const existing = candidates.find(item => (isbn && isbn === item.isbn) || (title && title.toLowerCase() === item.title.toLowerCase() && author.toLowerCase() === item.author.toLowerCase()));
    const extra = {};
    if (coverUrl(book.coverUrl)) extra.coverUrl = coverUrl(book.coverUrl);
    for (const key of ['publisher', 'publicationDate', 'language', 'edition', 'audience', 'category']) {
      const value = clean(book[key]);
      if (value) extra[key] = value;
    }
    const rating = book.goodreadsRating;
    if (rating && Number.isFinite(rating.value) && rating.value >= 0 && rating.value <= 5 && Number.isSafeInteger(rating.count) && rating.count >= 0 && rating.count <= 1000000000) {
      extra.goodreadsRating = { value: rating.value, count: rating.count };
    }
    if (existing) {
      if (!existing.title) existing.title = title;
      if (!existing.author) existing.author = author;
      if (!existing.isbn) existing.isbn = isbn;
      for (const [key, value] of Object.entries(extra)) if (!existing[key]) existing[key] = value;
      return;
    }
    if (candidates.length < 20) candidates.push({ title, author, isbn, source, ...extra });
  };

  const nodes = [], refs = new Map();
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 12 || nodes.length >= 1500) return;
    if (Array.isArray(node)) { for (const child of node.slice(0, 100)) visit(child, depth + 1); return; }
    nodes.push(node);
    if (typeof node['@id'] === 'string') {
      const existing = refs.get(node['@id']);
      if (!existing || Object.keys(node).length > Object.keys(existing).length) refs.set(node['@id'], node);
    }
    for (const child of Object.values(node)) if (child && typeof child === 'object') visit(child, depth + 1);
  };
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 30)) {
    const raw = script.textContent;
    if (raw.length > 250000) continue;
    try { visit(JSON.parse(raw)); } catch { /* A broken metadata block does not block other detection. */ }
  }
  // Amazon pages can put cart/sidebar headings (such as “Subtotal”) before
  // the actual book heading. Prefer retailer product-title IDs before generic h1.
  const mainTitle = textOf(document.querySelector('#productTitle, #title, #main-title, #pdp-product-title-id')) || textOf([...document.querySelectorAll('h1')].find(el => !/^(subtotal|amazon\.com)$/i.test(clean(el.innerText))));
  const titleKey = value => clean(value).split(':')[0].normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const hostname = location.hostname.toLowerCase().replace(/^www\./, '');
  const amazonAuthors = [...document.querySelectorAll('#bylineInfo .author')].filter(visible)
    .filter(el => !textOf(el.querySelector('.contribution')) || /\bAuthor\b/i.test(textOf(el.querySelector('.contribution'))))
    .map(el => textOf(el.querySelector('a'))).filter(Boolean).slice(0, 6).join(', ');
  const bnAuthors = [...document.querySelectorAll('.product__contributor a, .contributors a, #key-contributors a')].filter(visible)
    .filter(el => !/\((?:Foreword|Introduction|Translator|Illustrator|Editor)/i.test(textOf(el.parentElement)))
    .map(textOf).filter(Boolean).filter((name, i, all) => all.indexOf(name) === i).slice(0, 6).join(', ');
  const primaryAuthor = amazonAuthors || (hostname === 'barnesandnoble.com' ? bnAuthors : '') ||
    (hostname === 'goodreads.com' ? textOf(document.querySelector('.BookPageTitleSection .ContributorLink__name, .BookPageTitleSection .ContributorLink, #bookAuthors .authorName')) : '');
  let selectedVariant;
  if (hostname === 'barnesandnoble.com') {
    const ean = validIsbn(new URL(location.href).searchParams.get('ean') || new URL(location.href).searchParams.get('isbn'));
    const group = nodes.find(node => typeIs(node, 'ProductGroup') && clean(node.name).toLowerCase() === mainTitle.toLowerCase());
    const variants = list(group?.hasVariant);
    selectedVariant = variants.find(variant => {
      const isbn = validIsbn(variant?.sku || variant?.gtin13 || variant?.isbn);
      return isbn && (!ean || isbn === ean);
    });
    const variantIsbn = validIsbn(selectedVariant?.sku || selectedVariant?.gtin13 || selectedVariant?.isbn);
    const isbn = ean || variantIsbn;
    if (isbn && mainTitle) {
      const authorRef = typeof group?.author === 'string' ? group.author : '';
      const authorSlug = (() => { try { return new URL(authorRef).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; } })();
      const author = authorSlug ? [...document.querySelectorAll('a[href]')].filter(visible).find(link => {
        try { return new URL(link.href).pathname.endsWith(`/${authorSlug}`); } catch { return false; }
      }) : null;
      add({ title: mainTitle, author: primaryAuthor || textOf(author), isbn, publisher: group?.publisher?.name || group?.publisher, publicationDate: group?.datePublished, coverUrl: selectedVariant?.image || group?.image }, 'Barnes & Noble product details');
    }
  }
  const resolve = node => typeof node === 'string' && refs.has(node) ? refs.get(node) : node && typeof node === 'object' && node['@id'] && refs.has(node['@id']) ? refs.get(node['@id']) : node;
  const selectedFormat = [...document.querySelectorAll('#tmmSwatches .selected, #tmmSwatches .a-button-selected, #tmmSwatches [aria-pressed="true"], #tmmSwatches [aria-checked="true"], #formats [aria-selected="true"], #bindingSelector .a-button-selected, .product__formats [aria-checked="true"]')].filter(el => el.getClientRects().length > 0 && !el.closest('[hidden], [aria-hidden="true"]')).slice(0, 12).map(el => clean(el.textContent, 160)).join(' ') || clean(selectedVariant?.bookFormat);
  const audioText = value => /\baudio\s*book\b|\baudible\b|\baudio\s*cd\b/i.test(value);
  const isAudioNode = node => typeIs(node, 'Audiobook') || list(node.bookFormat).some(value => typeof value === 'string' && /(?:Audiobook|AudioBookFormat)$/i.test(value));
  const bookNodes = nodes.filter(node => typeIs(node, 'Book') || typeIs(node, 'Audiobook'));
  const structuredAudio = bookNodes.some(node => isAudioNode(node) && (mainTitle ? clean(node.name || node.headline).toLowerCase() === mainTitle.toLowerCase() : bookNodes.length === 1));
  const audioEdition = selectedFormat ? audioText(selectedFormat) : structuredAudio || audioText(textOf(document.querySelector('#productSubtitle, #binding'))) || Boolean(document.querySelector('#audibleProductDetails'));
  const authorName = value => list(value).slice(0, 6).map(resolve).map(a => typeof a === 'string' ? (/^https?:\/\//i.test(a) ? '' : a) : a?.name).filter(a => typeof a === 'string' && a).join(', ');
  const goodreadsVisibleRating = hostname === 'goodreads.com' ? (() => {
    const element = [...document.querySelectorAll('[aria-label*="Average rating"]')].filter(visible).find(node => /stars?.*ratings?/i.test(node.getAttribute('aria-label') || node.innerText || ''));
    const label = clean(element?.getAttribute('aria-label') || element?.innerText, 240);
    const value = Number(label.match(/(?:average rating of\s*)?(\d(?:\.\d+)?)\s*stars?/i)?.[1]);
    const countText = label.match(/([\d,]+)\s+ratings?/i)?.[1];
    const count = Number(countText?.replace(/,/g, ''));
    return Number.isFinite(value) && value >= 0 && value <= 5 && Number.isSafeInteger(count) && count >= 0 && count <= 1000000000 ? { value, count } : undefined;
  })() : undefined;
  if (hostname === 'goodreads.com') {
    // Read only the current edition's bibliographic record. Never traverse or
    // return the account, review, token or recommendation parts of page state.
    const script = document.querySelector('script#__NEXT_DATA__');
    if (script?.textContent.length <= 2000000) {
      try {
        const state = JSON.parse(script.textContent)?.props?.pageProps?.apolloState;
        const legacyId = location.pathname.match(/\/book\/show\/(\d+)/)?.[1];
        const record = Object.values(state || {}).find(node => node?.__typename === 'Book' && String(node.legacyId) === legacyId);
        if (record) {
          const details = record.details || {};
          const contributor = edge => state?.[edge?.node?.__ref]?.name || edge?.node?.name;
          const author = [contributor(record.primaryContributorEdge), ...list(record.secondaryContributorEdges).filter(edge => edge?.role === 'Author').map(contributor)].filter(Boolean).join(', ');
          const time = details.publicationTime;
          const publicationDate = typeof time === 'number' && Number.isFinite(time) && Math.abs(time) < 8640000000000000 ? new Date(time).toISOString().slice(0, 10) : '';
          add({ title: record.titleComplete || record.title, author: author || primaryAuthor, isbn: details.isbn13 || details.isbn, publisher: details.publisher, publicationDate, language: details.language?.name, coverUrl: record.imageUrl, goodreadsRating: goodreadsVisibleRating }, 'Goodreads edition details');
        }
      } catch { /* Visible/JSON-LD details can still identify the book. */ }
    }
  }
  for (const node of nodes) {
    const isbn = list(node.isbn).flatMap(isbns)[0] || isbns(node.gtin13)[0] || '';
    const isBook = typeIs(node, 'Book') || typeIs(node, 'Audiobook');
    if (isBook || (typeIs(node, 'Product') && isbn)) {
      const publisher = list(node.publisher).map(resolve).map(value => typeof value === 'string' ? value : value?.name).filter(value => typeof value === 'string').join(', ');
      const language = typeof node.inLanguage === 'string' ? node.inLanguage : node.inLanguage?.name;
      const rawAudience = typeof node.audience === 'string' ? node.audience : node.audience?.audienceType;
      const audience = /^(adult|adults)$/i.test(rawAudience || '') ? 'Adults' : /^(teen|teens|young adult)$/i.test(rawAudience || '') ? 'Teens' : /^(kids|children|juvenile)$/i.test(rawAudience || '') ? 'Kids' : '';
      const genres = list(node.genre).filter(value => typeof value === 'string');
      const category = genres.some(value => /^non[ -]?fiction$/i.test(value)) ? 'Nonfiction' : genres.some(value => /^fiction$/i.test(value)) ? 'Fiction' : '';
      const aggregate = resolve(node.aggregateRating);
      const rawRating = aggregate?.ratingValue;
      const rawCount = aggregate?.ratingCount ?? aggregate?.reviewCount;
      const ratingValue = Number(rawRating);
      const ratingCount = Number(rawCount);
      const goodreadsRating = hostname === 'goodreads.com' && rawRating != null && rawRating !== '' && rawCount != null && rawCount !== '' && Number.isFinite(ratingValue) && ratingValue >= 0 && ratingValue <= 5 && Number.isSafeInteger(ratingCount) && ratingCount >= 0 && ratingCount <= 1000000000
        ? { value: ratingValue, count: ratingCount } : goodreadsVisibleRating;
      add({ title: node.name || node.headline, author: authorName(node.author) || primaryAuthor, isbn, publisher, publicationDate: node.datePublished, language, edition: node.bookEdition, audience, category, coverUrl: coverUrl(list(node.image)[0]), goodreadsRating }, 'Book metadata');
    }
  }

  for (const node of [...document.querySelectorAll('[itemscope][itemtype*="schema.org/Book"]')].slice(0, 20)) {
    const value = property => {
      const el = node.querySelector(`[itemprop="${property}"]`);
      return el?.getAttribute('content') || textOf(el);
    };
    add({ title: value('name'), author: value('author'), isbn: isbns(value('isbn'))[0], publisher: value('publisher'), publicationDate: value('datePublished'), language: value('inLanguage'), edition: value('bookEdition') }, 'Book metadata');
  }
  const metaIsbn = isbns(meta(['book:isbn', 'books:isbn', 'isbn', 'og:isbn']))[0];
  const isBookPage = /^(books?([.:]|$))/.test(meta(['og:type']));
  const productTitle = textOf(document.querySelector('#productTitle, #title, #main-title, #pdp-product-title-id'));
  const labeledIsbns = [];
  const pageMetadata = {};
  const readLabeledDetails = node => {
    const raw = (node.innerText || '').slice(0, 12000).replace(/[\u200e\u200f\u202a-\u202e]/g, '');
    for (const [key, label] of [['publisher', 'Publisher'], ['publicationDate', 'Publication date'], ['language', 'Language'], ['edition', 'Edition']]) {
      const match = raw.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*:?\\s*([^\\n]+)`, 'i'));
      if (match && !pageMetadata[key]) pageMetadata[key] = clean(match[1]);
    }
  };
  for (const node of [...document.querySelectorAll('#detailBullets_feature_div, #productDetails_detailBullets_sections1, #productDetails_techSpec_section_1, [itemprop="isbn"]')].slice(0, 20)) {
    if (visible(node)) { labeledIsbns.push(...isbns(node.innerText)); readLabeledDetails(node); }
  }
  for (const row of [...document.querySelectorAll('#productDetails_detailBullets_sections1 tr, #productDetails_techSpec_section_1 tr')].slice(0, 40)) {
    const label = clean(row.querySelector('th')?.innerText).toLowerCase().replace(/:$/, '');
    const key = { publisher: 'publisher', 'publication date': 'publicationDate', language: 'language', edition: 'edition' }[label];
    if (key) pageMetadata[key] = textOf(row.querySelector('td'));
    if (/^isbn(?:-1[03])?$/.test(label)) labeledIsbns.push(...isbns(textOf(row.querySelector('td'))));
  }
  // Only scan general page text when structured data and explicit detail
  // sections have not already supplied an ISBN. This avoids walking large
  // retailer/review pages when their book metadata is complete.
  if (!candidates.some(candidate => candidate.isbn) && !['goodreads.com', 'barnesandnoble.com'].includes(hostname)) {
    let budget = 40000;
    for (const node of [...document.querySelectorAll('p, li, td, dd')].slice(0, 250)) {
      if (!visible(node) || budget <= 0) continue;
      const text = (node.innerText || '').slice(0, 1200);
      budget -= text.length;
      if (/\bISBN(?:-1[03])?\s*:?\s*/i.test(text)) {
        for (const match of text.matchAll(/\bISBN(?:-1[03])?\s*:?\s*([\dXx][\dXx\s-]{8,24})/gi)) labeledIsbns.push(...isbns(match[1]));
      }
    }
  }
  if (!candidates.length) {
    const url = new URL(location.href);
    const pathIsbn = isbns(`${url.pathname} ${url.search}`)[0];
    if (pathIsbn) {
      const author = primaryAuthor || meta(['book:author', 'books:author', 'author']) || textOf(document.querySelector('[itemprop="author"] [itemprop="name"], #bylineInfo .author a, #bylineInfo a[href*="/e/"], [itemprop="author"], .book-author'));
      add({ title: mainTitle || meta(['og:title']) || clean(document.title), author, isbn: pathIsbn }, 'ISBN in book URL');
    }
  }
  if (metaIsbn || isBookPage || labeledIsbns.length) {
    const title = productTitle || textOf(document.querySelector('h1')) || meta(['og:title']) || clean(document.title);
    const author = primaryAuthor || meta(['book:author', 'books:author']) || textOf(document.querySelector('[itemprop="author"] [itemprop="name"], #bylineInfo .author a, .book-author'));
    if (!candidates.length) {
      const found = [...new Set([metaIsbn, ...labeledIsbns].filter(Boolean))];
      if (found.length > 1 && !productTitle && !isBookPage) {
        // Don't assign the review's headline to every ISBN in a multi-book article.
        for (const isbn of found.slice(0, 20)) add({ title: '', author: '', isbn }, 'ISBN found on page');
      } else add({ ...pageMetadata, title, author, isbn: found[0], publisher: pageMetadata.publisher || meta(['book:publisher', 'books:publisher']), publicationDate: pageMetadata.publicationDate || meta(['book:release_date', 'books:release_date', 'book:published_time']) }, 'Page book details');
    }
  }
  // Goodreads does not expose an ISBN for every edition (for example Kindle).
  // A title and byline can still be corroborated against a selected catalog.
  const hasPrimary = candidates.some(book => mainTitle && titleKey(book.title) === titleKey(mainTitle));
  if (!hasPrimary && hostname === 'goodreads.com' && mainTitle && primaryAuthor) add({ title: mainTitle, author: primaryAuthor, goodreadsRating: goodreadsVisibleRating }, 'Goodreads book heading');
  if (!hasPrimary && mainTitle && primaryAuthor && /(^|\.)amazon\./.test(hostname) && (/kindle|paperback|hardcover|audio/i.test(selectedFormat) || document.querySelector('#ebooksImgBlkFront, #bookDescription_feature_div'))) add({ ...pageMetadata, title: mainTitle, author: primaryAuthor }, 'Amazon book heading');
  const primary = candidates.filter(book => mainTitle && titleKey(book.title) === titleKey(mainTitle));
  if (primary.length && ['goodreads.com', 'barnesandnoble.com', 'amazon.com'].includes(hostname)) {
    candidates.splice(0, candidates.length, ...primary);
  }
  if (candidates.length === 1) {
    if (!candidates[0].author) candidates[0].author = primaryAuthor;
    if (primaryAuthor && (hostname === 'barnesandnoble.com' || /(^|\.)amazon\./.test(hostname))) candidates[0].author = primaryAuthor;
    for (const [key, value] of Object.entries(pageMetadata)) if (!candidates[0][key]) candidates[0][key] = value;
    const image = document.querySelector('#landingImage, #imgBlkFront, #ebooksImgBlkFront, img[itemprop="image"]');
    if (!candidates[0].coverUrl) candidates[0].coverUrl = coverUrl(image?.currentSrc || image?.src || document.querySelector('meta[property="og:image"]')?.content);
  }
  return { candidates, pageTitle: clean(document.title), audioEdition };
}
