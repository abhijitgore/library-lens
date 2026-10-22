export function renderCover(url) {
  const image = document.getElementById('book-cover');
  const fallback = document.getElementById('cover-fallback');
  image.hidden = true;
  fallback.hidden = false;
  image.removeAttribute('src');
  if (!url || typeof url !== 'string' || !url.startsWith('https://')) return;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname) || parsed.hostname.startsWith('[') || /(?:^|\.)(?:localhost|local|internal)$/.test(parsed.hostname)) return;
  } catch { return; }
  image.onload = () => { image.hidden = false; fallback.hidden = true; };
  image.onerror = () => { image.hidden = true; fallback.hidden = false; };
  image.src = url;
}
