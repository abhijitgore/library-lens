import { normalizePreferredFormat } from './results.js';
import { LIBRARIES } from './catalog.js';

// Persist only non-identifying settings. ZIP is used for local ranking in the
// Settings page and is deliberately excluded from browser storage.
export function sanitizeLibraryPreferences(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const selectedIds = Array.isArray(source.selectedIds)
    ? [...new Set(source.selectedIds.filter(id => typeof id === 'string' && Object.hasOwn(LIBRARIES, id)))].slice(0, 3)
    : [];
  return { selectedIds, preferredFormat: normalizePreferredFormat(source.preferredFormat) };
}

// Normalize old settings on load. This removes the ZIP value written by older
// releases while preserving the user's library and format selections.
export async function loadLibraryPreferences(storage) {
  const { libraryPreferences: stored = {} } = await storage.get('libraryPreferences');
  const preferences = sanitizeLibraryPreferences(stored);
  if (JSON.stringify(stored) !== JSON.stringify(preferences)) {
    await storage.set({ libraryPreferences: preferences });
  }
  return preferences;
}
