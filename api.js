/* HEMIS adapters: no credentials are written to storage or included in URLs. */
export const UNIVERSITIES = Object.freeze([
  { name: 'TIFT', url: 'https://student.tift.uz' },
  { name: 'TUIT · ТАТУ', url: 'https://xmn.tuit.uz' },
  { name: 'TDTU · ТашГТУ', url: 'https://student.tdtu.uz' },
  { name: 'TSUE · ТГЭУ', url: 'https://talaba.tsue.uz' },
  { name: 'UzMU · НУУз', url: 'https://hstudent.nuu.uz' },
  { name: 'HEMIS', url: 'https://student.hemis.uz' }
]);

function bridgeOrigin() {
  const page = globalThis.location;
  return page && ['127.0.0.1', 'localhost'].includes(page.hostname) ? page.origin : 'http://127.0.0.1:8080';
}

export async function probeBridge({timeoutMs = 3000} = {}) {
  const origin = bridgeOrigin();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}/health`, {method: 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal});
    if (!response.ok) return {ok: false, code: 'BRIDGE_OUTDATED', message: 'Мост не отвечает на проверку. Запустите stop.bat, затем обновлённый start.bat.', url: origin};
    let data;
    try { data = await response.json(); } catch { return {ok: false, code: 'WRONG_SERVICE', message: 'На порту запущена другая программа. Остановите её и запустите start.bat.', url: origin}; }
    if (data.service !== 'hemis-planner-bridge' || data.protocol !== 1) return {ok: false, code: 'WRONG_SERVICE', message: 'Обнаружен другой или устаревший сервер. Запустите stop.bat, затем start.bat из обновлённой папки.', url: origin};
    return {ok: true, code: 'READY', message: 'Локальный мост работает. Можно подключаться к HEMIS.', version: data.version, url: origin};
  } catch {
    return {ok: false, code: 'BRIDGE_UNREACHABLE', message: 'Локальный мост недоступен браузеру. Запустите start.bat на этом компьютере. Если он уже запущен — откройте локальную версию приложения.', url: origin};
  } finally { clearTimeout(timer); }
}

const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const label = value => text(value?.name ?? value?.title ?? value?.full_name ?? value);
const keyName = value => text(value).normalize('NFKC').toLowerCase().replace(/[‘’ʻʼ`]/g, "'").replace(/\s+/g, ' ').trim();
const hash = value => { let h = 2166136261; for (const char of value) h = Math.imul(h ^ char.codePointAt(0), 16777619); return (h >>> 0).toString(36); };
const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const firstNumber = (...values) => values.map(numeric).find(value => value !== null) ?? null;

function assertSuccess(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('HEMIS вернул данные неизвестного формата.');
  if (raw.success === false || raw.ok === false || raw.error) {
    throw new Error(text(raw.message ?? raw.error?.message ?? raw.error) || 'HEMIS сообщил об ошибке.');
  }
}

function rows(raw, hint = '') {
  assertSuccess(raw);
  if (Array.isArray(raw)) return raw;
  for (const field of [hint, 'items', 'data', 'results', 'records', 'list'].filter(Boolean)) {
    if (Array.isArray(raw[field])) return raw[field];
    if (raw[field] && typeof raw[field] === 'object') {
      try { return rows(raw[field], hint); } catch (error) { if (raw[field].success === false) throw error; }
    }
  }
  // Some portals group lessons by YYYY-MM-DD or weekday.
  const groups = Object.entries(raw).filter(([name, value]) => Array.isArray(value) && (/^\d{4}-\d{2}-\d{2}$/.test(name) || /^[1-7]$/.test(name)));
  if (groups.length) return groups.flatMap(([name, values]) => values.map(value => ({ ...value, ...(name.length > 1 ? { date: value.date ?? name } : { day: value.day ?? Number(name) }) })));
  throw new Error('Не найден массив записей HEMIS. Ожидается data, items или JSON-массив.');
}

function subjectInfo(row, bareSubject = false) {
  const subject = row.subject ?? row.discipline ?? row.subjectInfo;
  const name = label(subject) || text(row.subject_name ?? row.subjectName ?? (bareSubject ? row.name : ''));
  const remoteId = text(subject?.id ?? subject?.code ?? row.subject_id ?? row._subject ?? row.subjectId ?? (bareSubject ? row.id ?? row.code : ''));
  if (!name && !remoteId) return null;
  return { id: remoteId ? `hemis-${remoteId}` : `subject-${hash(keyName(name))}`, name: name || `Предмет ${remoteId}` };
}

function weekday(row) {
  const value = row.day ?? row.weekday ?? row.week_day ?? row.dayOfWeek;
  const day = Number(value?.code ?? value?.id ?? value);
  if (Number.isInteger(day) && day >= 1 && day <= 7) return day;
  const words = ['пон', 'вто', 'сре', 'чет', 'пят', 'суб', 'вос'];
  const alternatives = ['mon|dushan', 'tue|seshan', 'wed|chorshan', 'thu|payshan', 'fri|juma', 'sat|shanba', 'sun|yakshan'];
  const name = label(value).toLowerCase();
  const index = words.findIndex((word, i) => name.startsWith(word) || new RegExp(`^(?:${alternatives[i]})`).test(name));
  if (index !== -1) return index + 1;
  const dateValue = row.lesson_date ?? row.date ?? row.lessonDate;
  let date;
  if (typeof dateValue === 'number' || /^\d{10,13}$/.test(String(dateValue))) date = new Date(Number(dateValue) * (Number(dateValue) < 1e12 ? 1000 : 1));
  else if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateValue))) date = new Date(`${dateValue}T12:00:00+05:00`);
  else if (dateValue) date = new Date(dateValue);
  if (!date || Number.isNaN(date.getTime())) return null;
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tashkent', weekday: 'short' }).format(date)) + 1;
}

function clock(value) {
  const match = text(value).match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
}

function parseSchedule(raw) {
  const input = rows(raw, 'schedule');
  const result = new Map();
  let rejected = 0;
  for (const row of input) {
    if (!row || typeof row !== 'object') { rejected++; continue; }
    const subject = subjectInfo(row);
    const pair = row.lessonPair ?? row.lesson_pair ?? row.pair ?? {};
    const timeRange = text(row.time).match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);
    const start = clock(row.start ?? row.start_time ?? row.startTime ?? pair.start_time ?? pair.start ?? timeRange?.[1]);
    const end = clock(row.end ?? row.end_time ?? row.endTime ?? pair.end_time ?? pair.end ?? timeRange?.[2]);
    const day = weekday(row);
    if (!subject || !start || !end || end <= start || !day || day > 6) { rejected++; continue; }
    const room = label(row.auditorium ?? row.room ?? row.classroom) || 'Не указана';
    const type = label(row.trainingType ?? row.training_type ?? row.lessonType ?? row.type) || 'Занятие';
    const teacher = label(row.employee ?? row.teacher ?? row.instructor) || 'Не указан';
    // A lesson repeated on several calendar weeks is one weekly slot; distinct rooms/types remain distinct.
    const identity = [subject.id, day, start, end, room, type, teacher].join('|');
    result.set(identity, { id: `lesson-${hash(identity)}`, subjectId: subject.id, subject: subject.name, day, start, end, room, type, teacher, source: 'hemis' });
  }
  if (input.length && !result.size) throw new Error('Ни одна пара не распознана: нужны предмет, день Пн–Сб и время начала/конца.');
  return { schedule: [...result.values()].sort((a, b) => a.day - b.day || a.start.localeCompare(b.start)), rejected };
}

export function normalizeSchedule(raw) { return parseSchedule(raw).schedule; }

function absence(row) {
  const excused = firstNumber(row.excusedHours, row.excused_hours, row.excused);
  const unexcused = firstNumber(row.unexcusedHours, row.unexcused_hours, row.unexcused);
  if (excused !== null || unexcused !== null) return [excused ?? 0, unexcused ?? 0];
  const on = numeric(row.absent_on), off = numeric(row.absent_off);
  if (on !== null || off !== null) {
    const hours = (on ?? 0) + (off ?? 0);
    if (row.explicable !== undefined && row.explicable !== null) {
      const justified = row.explicable === true || row.explicable === 1 || row.explicable === '1';
      return justified ? [hours, 0] : [0, hours];
    }
    return [on ?? 0, off ?? 0];
  }
  const hours = firstNumber(row.missed_hours, row.absent_hours, row.hours);
  const status = keyName(label(row.status));
  if (hours !== null && (row.absent === true || row.is_absent === true || /absent|missed|пропуск|нб/.test(status))) {
    return row.explicable === true || row.is_excused === true ? [hours, 0] : [0, hours];
  }
  return [0, 0];
}

export function normalizeSubjects(raw, attendanceRaw = []) {
  const input = rows(raw, 'subjects');
  const subjects = new Map(), aliases = new Map();
  for (const row of input) {
    if (!row || typeof row !== 'object') continue;
    const item = subjectInfo(row, true);
    if (!item) continue;
    const total = firstNumber(row.contact_hours, row.classroom_hours, row.totalHours, row.total_hours, row.total_acload, row.acload, row.hours, row.subject?.total_acload);
    const [excusedHours, unexcusedHours] = absence(row);
    const previous = subjects.get(item.id);
    subjects.set(item.id, { ...item, totalHours: total > 0 ? total : previous?.totalHours ?? null, excusedHours: Math.max(previous?.excusedHours ?? 0, excusedHours), unexcusedHours: Math.max(previous?.unexcusedHours ?? 0, unexcusedHours) });
    aliases.set(keyName(item.name), item.id);
  }
  const attendance = new Map(), seen = new Set();
  for (const row of rows(attendanceRaw, 'attendance')) {
    if (!row || typeof row !== 'object') continue;
    const item = subjectInfo(row);
    if (!item) continue;
    const id = subjects.has(item.id) ? item.id : aliases.get(keyName(item.name)) ?? item.id;
    const unique = row.id !== undefined ? `${id}:${row.id}` : JSON.stringify(row);
    if (seen.has(unique)) continue;
    seen.add(unique);
    if (!subjects.has(id)) subjects.set(id, { ...item, id, totalHours: null, excusedHours: 0, unexcusedHours: 0 });
    const [excused, unexcused] = absence(row), total = attendance.get(id) ?? [0, 0];
    attendance.set(id, [total[0] + excused, total[1] + unexcused]);
  }
  for (const [id, [excusedHours, unexcusedHours]] of attendance) Object.assign(subjects.get(id), { excusedHours, unexcusedHours });
  if (input.length && !subjects.size) throw new Error('Не удалось распознать предметы в ответе HEMIS.');
  return [...subjects.values()];
}

export function importHemisData(raw) {
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { throw new Error('Некорректный JSON. Проверьте скобки и кавычки.'); } }
  assertSuccess(raw);
  const bundle = !Array.isArray(raw) && raw.schedule !== undefined ? raw : { schedule: raw, subjects: [], attendance: [] };
  const { schedule, rejected } = parseSchedule(bundle.schedule);
  const subjects = normalizeSubjects(bundle.subjects ?? [], bundle.attendance ?? []);
  const byId = new Map(subjects.map(item => [item.id, item]));
  const byName = new Map(subjects.map(item => [keyName(item.name), item]));
  for (const lesson of schedule) {
    const match = byId.get(lesson.subjectId) ?? byName.get(keyName(lesson.subject));
    if (match) { lesson.subjectId = match.id; lesson.subject = match.name; }
    else {
      const item = { id: lesson.subjectId, name: lesson.subject, totalHours: null, excusedHours: 0, unexcusedHours: 0 };
      subjects.push(item); byId.set(item.id, item); byName.set(keyName(item.name), item);
    }
  }
  const warnings = [];
  if (rejected) warnings.push(`Пропущено записей без корректного времени/предмета или вне Пн–Сб: ${rejected}.`);
  if (subjects.some(item => item.totalHours === null)) warnings.push('Для части предметов не указаны часы: заполните их вручную для расчёта лимита НБ.');
  if (bundle.subjects && rows(bundle.subjects, 'subjects').some(row => row?.total_acload && !row.contact_hours && !row.classroom_hours)) warnings.push('HEMIS передал общую нагрузку total_acload. Проверьте, что часы для лимита НБ соответствуют аудиторным занятиям.');
  if (bundle.attendance && rows(bundle.attendance, 'attendance').some(row => row && (row.absent_on != null || row.absent_off != null) && row.explicable == null)) warnings.push('Записи без explicable: absent_on учтены как уважительные, absent_off — как неуважительные часы. Сверьте с порталом вуза.');
  return { schedule, subjects, warnings };
}

class RequestError extends Error {
  constructor(message, status = 0, terminal = false) { super(message); this.status = status; this.terminal = terminal; }
}

function portalUrl(value) {
  let url;
  try { url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); } catch { throw new Error('Введите корректный HTTPS-адрес студенческого портала.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || /^(?:\d+\.){3}\d+$/.test(url.hostname) || url.hostname.endsWith('.local')) throw new Error('Нужен публичный HTTPS-домен HEMIS без логина, пароля и порта.');
  return url.origin;
}

export class HemisClient {
  constructor({ baseUrl, token = '', allowPublicProxy = false, onStatus = () => {} }) {
    this.baseUrl = portalUrl(baseUrl);
    this.token = text(token).replace(/^Bearer\s+/i, '');
    this.allowPublicProxy = Boolean(allowPublicProxy);
    this.onStatus = onStatus;
    this.bridgeUnavailable = false;
    this.bridgeChecked = false;
  }

  async request(path, { method = 'GET', body } = {}) {
    const target = `${this.baseUrl}/rest/v1/${path}`;
    const routes = [];
    const failures = [];
    if (!this.bridgeChecked) {
      this.onStatus('Проверяем локальный мост…');
      this.bridgeStatus = await probeBridge();
      this.bridgeUnavailable = !this.bridgeStatus.ok;
      this.bridgeChecked = true;
    }
    if (!this.bridgeUnavailable) routes.push({ name: 'Локальный мост', url: `${bridgeOrigin()}/hemis-proxy`, bridge: true });
    else failures.push(`Локальный мост: ${this.bridgeStatus?.message || 'недоступен'}`);
    routes.push({ name: 'Прямое подключение', url: target });
    // Public services receive the bearer token. Only an explicit opt-in enables GET fallback.
    // Password login is never relayed to public proxies.
    if (this.allowPublicProxy && method === 'GET') routes.push(
      { name: 'Публичный прокси corsproxy.io', url: `https://corsproxy.io/?url=${encodeURIComponent(target)}` },
      { name: 'Публичный прокси cors.eu.org', url: `https://cors.eu.org/${target}` }
    );
    for (const route of routes) {
      this.onStatus(`${route.name}…`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), route.bridge ? 26000 : 18000);
      try {
        const headers = route.bridge ? { 'Content-Type': 'text/plain' } : { Accept: 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
        const response = await fetch(route.url, { method: route.bridge ? 'POST' : method, headers, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal, ...(route.bridge ? { body: JSON.stringify({ target, method, token: this.token, body }) } : body ? { body: JSON.stringify(body) } : {}) });
        const content = await response.text();
        let payload;
        try { payload = JSON.parse(content); } catch { throw new RequestError(`Вместо JSON получена страница сервера (HTTP ${response.status}).`, response.status); }
        const status = route.bridge ? Number(payload.status ?? response.status) : response.status;
        const data = route.bridge ? payload.data : payload;
        if (!response.ok || route.bridge && !payload.ok || status >= 400) {
          const bridgeErrors = {UPSTREAM_TIMEOUT:'Мост работает, но портал HEMIS не ответил вовремя.',UPSTREAM_TLS:'Мост не смог установить доверенное HTTPS-соединение с порталом HEMIS.',UPSTREAM_NETWORK:'Мост не смог найти портал HEMIS или подключиться к нему. Проверьте адрес и сеть.',BRIDGE_ERROR:'Мост получил запрос, но не смог его выполнить. Проверьте доступ к порталу и обновите локальный сервер.'};
          const message = status === 401 ? 'HEMIS отклонил авторизацию. Проверьте логин, пароль или срок токена.' : status === 429 ? 'HEMIS ограничил частоту запросов. Повторите позже.' : bridgeErrors[payload.code] || `Ошибка HTTP ${status}: ${text(payload.error ?? data?.message ?? payload.message).slice(0, 160) || 'сервер недоступен'}`;
          throw new RequestError(message, status, [401, 422, 429].includes(status));
        }
        try { assertSuccess(data); } catch (error) { if (path === 'auth/login') throw new RequestError(error.message, status, true); throw error; }
        this.onStatus(`Подключено: ${route.name.toLowerCase()}`);
        return data;
      } catch (error) {
        if (error.terminal) throw error;
        if (route.bridge && (error instanceof TypeError || error.name === 'AbortError')) this.bridgeUnavailable = true;
        const reason = error.name === 'AbortError' ? 'время ожидания истекло' : error instanceof TypeError ? 'браузер не получил ответ: возможны CORS, ограничения сети или недоступность портала' : error.message;
        failures.push(`${route.name}: ${reason}`);
      } finally { clearTimeout(timeout); }
    }
    const failure = new Error(`${failures.join('\n')}\nДля Windows: запустите start.bat и выполните вход в открывшейся локальной версии. На GitHub Pages серверный мост не запускается. Альтернатива — импорт JSON. Это сетевая ошибка; правильность пароля пока не подтверждена.`);
    failure.code = 'CONNECTION_UNAVAILABLE';
    failure.bridge = this.bridgeStatus;
    throw failure;
  }

  async login(login, password) {
    if (!text(login) || !password) throw new Error('Введите ID/логин и пароль HEMIS.');
    const payload = await this.request('auth/login', { method: 'POST', body: { login: text(login), password } });
    const token = payload.data?.token ?? payload.data?.access_token ?? payload.data?.accessToken ?? payload.token ?? payload.access_token;
    if (typeof token !== 'string' || !token.trim()) throw new Error('HEMIS не вернул Bearer-токен. Возможно, портал использует другой способ авторизации.');
    this.token = token.replace(/^Bearer\s+/i, '').trim();
    return this.token;
  }

  async collection(path) {
    let page = 1, records = [], previous = '';
    while (page <= 100) {
      const payload = await this.request(`${path}${page > 1 ? `?page=${page}` : ''}`);
      const list = rows(payload);
      const signature = JSON.stringify(list);
      if (page > 1 && signature === previous && list.length) throw new Error('HEMIS повторяет страницу данных; загрузка остановлена, чтобы не завысить НБ.');
      records.push(...list); previous = signature;
      const pagination = payload.data?.pagination ?? payload.pagination ?? payload._meta ?? payload.data?._meta ?? payload.meta;
      const count = Number(pagination?.pageCount ?? pagination?.page_count ?? pagination?.last_page ?? 0);
      const next = payload.links?.next ?? payload._links?.next ?? payload.data?.links?.next;
      if ((!count || page >= count) && !next) return records;
      if (!list.length) throw new Error('HEMIS вернул пустую страницу до конца пагинации.');
      page++;
    }
    throw new Error('Слишком много страниц HEMIS. Уточните семестр на портале или используйте импорт JSON.');
  }

  async load() {
    if (!this.token) throw new Error('Сначала войдите в HEMIS или вставьте Bearer-токен.');
    // Sequential requests make bridge failure detection and visible connection status deterministic.
    const schedule = await this.collection('education/schedule');
    const subjects = await this.collection('education/subjects');
    const attendance = await this.collection('education/attendance');
    return importHemisData({ schedule, subjects, attendance });
  }
}
