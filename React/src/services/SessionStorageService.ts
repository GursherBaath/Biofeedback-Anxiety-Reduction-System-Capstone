import AsyncStorage from '@react-native-async-storage/async-storage';

const SESSIONS_KEY = '@calmcoach_sessions';
const DEMO_SESSIONS_KEY = '@calmcoach_sessions_demo';

export type SessionType = 'hrv' | 'amplitude' | 'ppg';

export interface Session {
  id: string;
  type: SessionType;
  startTime: number; // ms timestamp
  endTime: number;   // ms timestamp
  durSeconds: number;
  rmssd?: number;
  baselineRmssd?: number;
  endRmssd?: number;
  rmssdImprovementPct?: number;
  meanHR?: number;
  meanAmplitude?: number;
}

export async function saveSession(session: Session): Promise<void> {
  try {
    const existing = await loadSessions();
    const updated = [session, ...existing];
    await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn('[SessionStorage] save error:', e);
  }
}

export async function loadSessions(): Promise<Session[]> {
  try {
    const raw = await AsyncStorage.getItem(SESSIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('[SessionStorage] load error:', e);
    return [];
  }
}

export async function clearSessions(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SESSIONS_KEY);
  } catch (e) {
    console.warn('[SessionStorage] clear error:', e);
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  try {
    const existing = await loadSessions();
    const updated = existing.filter(s => s.id !== sessionId);
    await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn('[SessionStorage] delete error:', e);
  }
}

/** Returns sessions grouped into ISO weeks, sorted newest first.
 *  Each week: { weekStart: Date (monday), sessions: Session[] }
 */
export function groupByWeek(sessions: Session[]): {weekStart: Date; sessions: Session[]}[] {
  const map = new Map<string, Session[]>();
  for (const s of sessions) {
    const d = new Date(s.startTime);
    const day = d.getDay(); // 0=sun
    const diff = (day === 0 ? -6 : 1 - day); // shift to monday
    const monday = new Date(d);
    monday.setDate(d.getDate() + diff);
    monday.setHours(0, 0, 0, 0);
    const key = monday.toISOString();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  const weeks = Array.from(map.entries()).map(([key, sArr]) => ({
    weekStart: new Date(key),
    sessions: sArr.sort((a, b) => a.startTime - b.startTime),
  }));
  return weeks.sort((a, b) => b.weekStart.getTime() - a.weekStart.getTime());
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  return `${m} min`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  let h = d.getHours();
  const min = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  if (min === 0) return `${h}${ampm}`;
  return `${h}:${String(min).padStart(2, '0')}${ampm}`;
}

const DAY_ABBRS = ['Sun', 'Mon', 'Tues', 'Wed', 'Thurs', 'Fri', 'Sat'];
export function formatDayLabel(ts: number): string {
  const d = new Date(ts);
  return `${DAY_ABBRS[d.getDay()]} ${d.getDate()}`;
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
export function formatWeekLabel(weekStart: Date): string {
  const end = new Date(weekStart);
  end.setDate(weekStart.getDate() + 6);
  const sMonth = MONTH_NAMES[weekStart.getMonth()];
  const eMonth = MONTH_NAMES[end.getMonth()];
  if (sMonth === eMonth) {
    return `${sMonth} ${weekStart.getDate()} - ${end.getDate()}`;
  }
  return `${sMonth} ${weekStart.getDate()} - ${eMonth} ${end.getDate()}`;
}

// ── Demo storage ───────────────────────────────────────────────────────────

export function buildDemoSessions(): Session[] {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() + diff);
  thisMonday.setHours(0, 0, 0, 0);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);

  const m = thisMonday.getTime();
  const lm = lastMonday.getTime();
  const DAY = 86400000;
  const H = (h: number) => h * 3600000;

  return [
    {id: 'demo-1', type: 'hrv', startTime: m + H(9),           endTime: m + H(9) + 360000,           durSeconds: 360, baselineRmssd: 38.4, rmssdImprovementPct: 8.6,  rmssd: 41.7},
    {id: 'demo-2', type: 'hrv', startTime: m + DAY + H(7),     endTime: m + DAY + H(7) + 480000,     durSeconds: 480, baselineRmssd: 40.2, rmssdImprovementPct: 4.1,  rmssd: 41.8},
    {id: 'demo-3', type: 'hrv', startTime: m + 2*DAY + H(12),  endTime: m + 2*DAY + H(12) + 300000,  durSeconds: 300, baselineRmssd: 42.5, rmssdImprovementPct: 5.8,  rmssd: 45.0},
    {id: 'demo-3a', type: 'amplitude', startTime: m + 3*DAY + H(10), endTime: m + 3*DAY + H(10) + 300000, durSeconds: 300, meanAmplitude: 6.8, meanHR: 72},
    {id: 'demo-4', type: 'hrv', startTime: lm + H(8),          endTime: lm + H(8) + 420000,          durSeconds: 420, baselineRmssd: 34.8, rmssdImprovementPct: 7.3,  rmssd: 37.3},
    {id: 'demo-5', type: 'hrv', startTime: lm + DAY + H(20),   endTime: lm + DAY + H(20) + 360000,   durSeconds: 360, baselineRmssd: 36.2, rmssdImprovementPct: -1.9, rmssd: 35.5},
    {id: 'demo-6', type: 'hrv', startTime: lm + 2*DAY + H(9),  endTime: lm + 2*DAY + H(9) + 540000,  durSeconds: 540, baselineRmssd: 35.1, rmssdImprovementPct: 6.2,  rmssd: 37.3},
    {id: 'demo-7', type: 'hrv', startTime: lm + 3*DAY + H(7),  endTime: lm + 3*DAY + H(7) + 300000,  durSeconds: 300, baselineRmssd: 37.9, rmssdImprovementPct: 2.4,  rmssd: 38.8},
    {id: 'demo-8', type: 'hrv', startTime: lm + 4*DAY + H(18), endTime: lm + 4*DAY + H(18) + 480000, durSeconds: 480, baselineRmssd: 38.6, rmssdImprovementPct: 9.0,  rmssd: 42.1},
    {id: 'demo-9', type: 'amplitude', startTime: lm + 5*DAY + H(11), endTime: lm + 5*DAY + H(11) + 360000, durSeconds: 360, meanAmplitude: 5.4, meanHR: 74},
  ];
}

export async function loadDemoSessions(): Promise<Session[]> {
  try {
    const raw = await AsyncStorage.getItem(DEMO_SESSIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('[SessionStorage] demo load error:', e);
    return [];
  }
}

export async function saveDemoSessionRecord(session: Session): Promise<void> {
  try {
    const existing = await loadDemoSessions();
    const updated = [session, ...existing];
    await AsyncStorage.setItem(DEMO_SESSIONS_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn('[SessionStorage] demo save error:', e);
  }
}

export async function deleteDemoSessionRecord(sessionId: string): Promise<void> {
  try {
    const existing = await loadDemoSessions();
    const updated = existing.filter(s => s.id !== sessionId);
    await AsyncStorage.setItem(DEMO_SESSIONS_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn('[SessionStorage] demo delete error:', e);
  }
}
