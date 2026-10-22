export function cleanText(value, limit = 300) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

export function normalizeIsbn(value) {
  const isbn = String(value ?? '').replace(/^ISBN(?:-1[03])?\s*:?\s*/i, '').replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{13}$/.test(isbn) && /^(978|979)/.test(isbn)) {
    const sum = [...isbn].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0 ? isbn : '';
  }
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const sum = [...isbn].reduce((n, c, i) => n + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0 ? isbn : '';
  }
  return '';
}

export function isbn13(value) {
  const isbn = normalizeIsbn(value);
  if (isbn.length !== 10) return isbn;
  const prefix = '978' + isbn.slice(0, 9);
  const sum = [...prefix].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0);
  return prefix + ((10 - sum % 10) % 10);
}

export function normalizeWords(value) {
  return cleanText(value, 1000).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function titleKey(value) {
  return normalizeWords(value).replace(/^(the|a|an) /, '').replace(/ (a novel|a memoir)$/, '');
}

export function matchBook(book, record) {
  const wanted = isbn13(book.isbn);
  const exactIsbn = Boolean(wanted && record.isbns.some(isbn => isbn13(isbn) === wanted));
  const title = titleKey(book.title.split(':')[0]);
  const candidate = titleKey(record.title.split(':')[0]);
  const titleMatch = Boolean(title && title === candidate);
  const author = normalizeWords(book.author);
  const authorWords = author.split(' ').filter(word => word.length > 1);
  const authors = normalizeWords(record.authors.join(' ')).split(' ');
  const authorMatch = !author || (authorWords.length > 0 && authorWords.every(word => authors.includes(word)));
  return {
    exactIsbn,
    // ISBNs in library records can include several formats/editions. Format is always shown separately.
    strong: exactIsbn || (titleMatch && Boolean(author) && authorMatch),
    possible: exactIsbn || (titleMatch && authorMatch),
    label: exactIsbn ? 'ISBN match' : titleMatch && author && authorMatch ? 'Title + author match' : 'Check this match'
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NUMBERS = new Map([['january', 1], ['february', 2], ['march', 3], ['april', 4], ['may', 5], ['june', 6], ['july', 7], ['august', 8], ['september', 9], ['october', 10], ['november', 11], ['december', 12]]);

export function compactPublicationDate(value) {
  const date = cleanText(value, 80);
  if (!date) return '';
  const iso = date.match(/^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/);
  if (iso && Number(iso[2]) >= 1 && Number(iso[2]) <= 12) return `${MONTHS[Number(iso[2]) - 1]} ${iso[1]}`;
  const monthName = date.toLowerCase().match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
  const year = date.match(/\b(\d{4})\b/)?.[1];
  if (monthName && year) return `${MONTHS[MONTH_NUMBERS.get(monthName[1]) - 1]} ${year}`;
  const monthYear = date.match(/^(\d{1,2})[/-](\d{4})$/);
  if (monthYear && Number(monthYear[1]) >= 1 && Number(monthYear[1]) <= 12) return `${MONTHS[Number(monthYear[1]) - 1]} ${monthYear[2]}`;
  return year || '';
}

export function compactEdition(value) {
  const edition = cleanText(value, 80);
  if (!edition) return '';
  const words = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  const word = edition.toLowerCase().match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/)?.[1];
  const number = Number(edition.match(/\b(\d+)(?:st|nd|rd|th)?\b/i)?.[1] || (word ? words[word] : 0));
  if (!number) return edition.replace(/\bedition\b/i, 'ed.');
  const suffix = number % 100 >= 11 && number % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[number % 10] || 'th');
  return `${number}${suffix} ed.`;
}

export function compactBookMetadata({ author = '', publicationDate = '', edition = '', goodreadsRating } = {}) {
  const rating = goodreadsRating && Number.isFinite(goodreadsRating.value) && goodreadsRating.value >= 0 && goodreadsRating.value <= 5 && Number.isSafeInteger(goodreadsRating.count) && goodreadsRating.count >= 0 && goodreadsRating.count <= 1000000000
    ? `${goodreadsRating.value} stars from ${goodreadsRating.count} ratings` : '';
  return [cleanText(author, 120), compactPublicationDate(publicationDate), compactEdition(edition), rating].filter(Boolean).join(' · ');
}

export function bookSummary(book) {
  return [
    book.title && `Title: ${cleanText(book.title)}`,
    book.author && `Author: ${cleanText(book.author)}`,
    book.isbn && `ISBN: ${normalizeIsbn(book.isbn)}`,
    `Requested format: ${cleanText(book.format) || 'Print book'}`,
    book.publisher && `Publisher: ${cleanText(book.publisher)}`,
    book.publicationDate && `Publication date: ${cleanText(book.publicationDate, 40)}`,
    book.language && `Language: ${cleanText(book.language, 80)}`,
    book.edition && `Edition: ${cleanText(book.edition)}`,
    book.audience && `Audience: ${cleanText(book.audience, 40)}`,
    book.category && `Category: ${cleanText(book.category, 40)}`
  ].filter(Boolean).join('\n');
}

export function purchaseMetadata(book) {
  const fields = { publisher: 300, publicationDate: 40, language: 80, edition: 300, audience: 40, category: 40, format: 80 };
  return Object.fromEntries(Object.entries(fields).map(([key, length]) => [key, cleanText(book[key], length)]).filter(([, value]) => value));
}
