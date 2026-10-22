import { LIBRARIES } from './lib/catalog.js';
import { findLibrariesNearZip, formatDistance } from './lib/directory.js';
import { normalizePreferredFormat } from './lib/results.js';
import { loadLibraryPreferences, sanitizeLibraryPreferences } from './lib/preferences.js';

const $ = id => document.getElementById(id);
const libraryList = $('library-list');
const saveButton = $('save-libraries');
const NEARBY_LIMIT_MILES = 75;
let nearby = [];
let directory;
let savedIds = [];
let lastSearchedZip = '';

function status(message) { $('library-status').textContent = message; }

async function loadDirectory() {
  if (directory) return directory;
  const response = await fetch(chrome.runtime.getURL('data/library-locations.json'));
  if (!response.ok) throw new Error('Library location data could not be loaded.');
  directory = await response.json();
  return directory;
}

function selectedIds() {
  return [...libraryList.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
}

function updateSaveButton() {
  const selected = selectedIds();
  saveButton.disabled = selected.length < 1 || selected.length > 3 || !$('zip-code').validity.valid || lastSearchedZip !== $('zip-code').value.trim();
  status(selected.length > 3 ? 'Choose no more than three.' : `${selected.length} of 3 selected.`);
}

function renderLibraries() {
  libraryList.replaceChildren();
  const legend = document.createElement('legend');
  legend.textContent = 'Choose up to 3 libraries';
  libraryList.append(legend);
  if (!nearby.length) {
    const note = document.createElement('p');
    note.className = 'fine-print';
    note.textContent = `No supported library system was found within ${NEARBY_LIMIT_MILES} miles of this ZIP code.`;
    libraryList.append(note);
  }
  const appendChoice = (library, container) => {
    const label = document.createElement('label');
    label.className = 'library-choice';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = library.id;
    checkbox.checked = savedIds.includes(library.id);
    checkbox.setAttribute('aria-label', library.name);
    const text = document.createElement('span');
    const name = document.createElement('strong'); name.textContent = `${library.name} (${library.short})`;
    const distance = document.createElement('small'); distance.textContent = `Nearest branch · ${formatDistance(library.distanceMiles)}`;
    text.append(name, distance);
    label.append(checkbox, text);
    container.append(label);
    checkbox.addEventListener('change', () => {
      const checked = selectedIds();
      if (checked.length > 3) { checkbox.checked = false; status('Choose no more than three.'); }
      updateSaveButton();
    });
  };
  for (const library of nearby) appendChoice(library, libraryList);
  libraryList.hidden = false;
  updateSaveButton();
}

async function discover(zip) {
  status('Finding supported libraries…');
  $('find-libraries').disabled = true;
  saveButton.disabled = true;
  try {
    const data = await loadDirectory();
    nearby = findLibrariesNearZip(zip, data, Object.values(LIBRARIES))
      .filter(library => library.distanceMiles != null && library.distanceMiles <= NEARBY_LIMIT_MILES);
    lastSearchedZip = zip;
    savedIds = savedIds.filter(id => nearby.some(library => library.id === id));
    renderLibraries();
  } catch (error) {
    lastSearchedZip = '';
    libraryList.hidden = true;
    status(error.message || 'Could not find libraries for that ZIP.');
  } finally { $('find-libraries').disabled = false; }
}

$('library-search').addEventListener('submit', event => {
  event.preventDefault();
  discover($('zip-code').value);
});
$('zip-code').addEventListener('input', () => {
  if ($('zip-code').value.trim() !== lastSearchedZip) { lastSearchedZip = ''; libraryList.hidden = true; }
  updateSaveButton();
});
saveButton.addEventListener('click', async () => {
  const zip = $('zip-code').value.trim();
  const ids = selectedIds();
  if (!/^\d{5}$/.test(zip) || ids.length < 1 || ids.length > 3 || ids.some(id => !Object.hasOwn(LIBRARIES, id))) return;
  const current = (await chrome.storage.local.get('libraryPreferences')).libraryPreferences || {};
  await chrome.storage.local.set({ libraryPreferences: sanitizeLibraryPreferences({ ...current, selectedIds: ids, preferredFormat: normalizePreferredFormat($('preferred-format').value) }) });
  savedIds = ids;
  status('Saved. Library Lens will search these libraries.');
});

$('preferred-format').addEventListener('change', async () => {
  const preferredFormat = normalizePreferredFormat($('preferred-format').value);
  const current = (await chrome.storage.local.get('libraryPreferences')).libraryPreferences || {};
  await chrome.storage.local.set({ libraryPreferences: sanitizeLibraryPreferences({ ...current, preferredFormat }) });
  $('preferred-format-status').textContent = `Saved. ${$('preferred-format').selectedOptions[0].text} will appear first.`;
});

async function init() {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  const libraryPreferences = await loadLibraryPreferences(chrome.storage.local);
  $('preferred-format').value = libraryPreferences.preferredFormat;
  if (libraryPreferences?.preferredFormat && libraryPreferences.preferredFormat !== $('preferred-format').value) {
    $('preferred-format-status').textContent = 'Saved preference was not recognized. Print is selected.';
  } else if (libraryPreferences?.preferredFormat) {
    $('preferred-format-status').textContent = `${$('preferred-format').selectedOptions[0].text} is your saved preference.`;
  } else {
    $('preferred-format-status').textContent = 'Default: Print';
  }
  savedIds = libraryPreferences.selectedIds.filter(id => Object.hasOwn(LIBRARIES, id));
  status(savedIds.length ? 'Enter ZIP to review nearby libraries. Your saved choices remain active.' : 'Enter a ZIP code to choose libraries.');
}

init().catch(() => status('Settings could not load. Close this tab and try again.'));
