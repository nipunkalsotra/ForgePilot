import { ForgePilotError } from './log';

export function localBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ForgePilotError('TrueForge base URL is invalid.'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ForgePilotError('ForgePilot requires a loopback HTTP TrueForge URL, such as http://localhost:8790.');
  }
  return url.origin;
}
