// Lightweight shot reminder system backed by localStorage.
// Stores saved locations+times; checks on app open; uses Notification API if permitted.

const KEY = 'sunv2_reminders_v1';
const WINDOW_MS = 30 * 60 * 1000; // notify if within 30 minutes

export function saveReminder(observer, datetime, mode) {
  const list = getAll();
  const id = Date.now();
  list.push({
    id,
    lat: observer.lat,
    lon: observer.lon,
    datetime: datetime.toISOString(),
    mode,
  });
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
  return id;
}

export function getAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

export function removeReminder(id) {
  const list = getAll().filter((r) => r.id !== id);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
}

/** Returns reminders due within the next 30 minutes (or just passed within 5 min). */
export function getDueReminders() {
  const now = Date.now();
  return getAll().filter((r) => {
    const t = new Date(r.datetime).getTime();
    return t > now - 5 * 60 * 1000 && t < now + WINDOW_MS;
  });
}

export async function requestNotifPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  const result = await Notification.requestPermission().catch(() => 'denied');
  return result === 'granted';
}

export function sendNotification(reminder) {
  if (Notification.permission !== 'granted') return;
  const dt = new Date(reminder.datetime);
  new Notification('Sun · Light Planner', {
    body: `Saved shot · ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${reminder.mode}`,
    icon: 'icons/icon-192.svg',
  });
}

/** Check for due reminders and fire notifications or return a list for alert fallback. */
export function checkAndNotify() {
  const due = getDueReminders();
  if (!due.length) return [];
  if (Notification.permission === 'granted') {
    due.forEach(sendNotification);
  }
  return due; // caller can show a toast if notifications not available
}
