import { availabilityLabel, FORMAT_LABELS } from './catalog.js';
import { cleanText } from './books.js';

export const PREFERRED_FORMATS = Object.freeze({
  print: Object.freeze(['BK', 'LPRINT']),
  ebook: Object.freeze(['EBOOK']),
  audiobook: Object.freeze(['AB', 'AB_CD', 'EAB'])
});

export const PREFERRED_FORMAT_LABELS = Object.freeze({ print: 'Print', ebook: 'eBook', audiobook: 'Audiobook' });

export function normalizePreferredFormat(value) {
  return Object.hasOwn(PREFERRED_FORMATS, value) ? value : 'print';
}

export function isPreferredFormat(recordFormat, preferredFormat = 'print') {
  return PREFERRED_FORMATS[normalizePreferredFormat(preferredFormat)].includes(recordFormat);
}

export function compactRecord(record) {
  const formats = { BK: 'Print', LPRINT: 'Large print', EBOOK: 'eBook', AB: 'Audiobook', AB_CD: 'Audiobook CD', EAB: 'Downloadable audiobook' };
  const format = formats[record.format] || FORMAT_LABELS[record.format] || cleanText(record.format, 40) || 'Unknown format';
  const ordinals = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th', sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th' };
  const edition = cleanText(record.edition, 80).replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/gi, value => ordinals[value.toLowerCase()]).replace(/\bedition\b/gi, 'ed.').replace(/\.+$/, '.');
  const editionYear = [edition, cleanText(record.year, 40)].filter(Boolean).join(' / ');
  const status = availabilityLabel(record);
  const a = record.availability;
  const counted = ['available', 'waiting'].includes(status.tone) && a?.availableCopies != null && a?.totalCopies != null;
  const availability = counted ? `${a.availableCopies}/${a.totalCopies} available` : status.tone === 'waiting' ? 'Unavailable' : status.text;
  const holds = a?.heldCopies != null ? `${a.heldCopies} ${a.heldCopies === 1 ? 'hold' : 'holds'}` : '';
  return { format, editionYear, availability, holds, tone: status.tone };
}
