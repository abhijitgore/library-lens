const EARTH_RADIUS_MILES = 3958.7613;

export function findLibrariesNearZip(zipInput, directory, libraries) {
  const zip = String(zipInput || '').trim();
  if (!/^\d{5}$/.test(zip)) throw new Error('Enter a 5-digit ZIP code.');
  const center = directory?.zipCentroids?.[zip];
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) {
    throw new Error('We could not map that ZIP code. Check it and try again.');
  }
  return libraries.map(library => {
    const outlets = directory.systems?.[library.id]?.outlets || [];
    const distances = outlets.map(outlet => distanceMiles(center, [outlet.lat, outlet.lon])).filter(Number.isFinite);
    return { ...library, distanceMiles: distances.length ? Math.min(...distances) : null };
  }).sort((a, b) => (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity) || a.name.localeCompare(b.name));
}

export function formatDistance(miles) {
  if (!Number.isFinite(miles)) return 'Distance unavailable';
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

function distanceMiles([lat1, lon1], [lat2, lon2]) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return NaN;
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}
