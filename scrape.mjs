#!/usr/bin/env node
/**
 * Скрапер itorrents-igruha -> JSON-источник для Hydra Launcher
 *
 * Собирает последние раздачи с сайта, скачивает .torrent-файлы,
 * вычисляет infohash v1 и строит JSON формата Hydra:
 *
 * {
 *   "name": "Torrent Igruha",
 *   "downloads": [
 *     { "title": "...", "uris": ["magnet:?xt=urn:btih:..."], "uploadDate": "...", "fileSize": "..." }
 *   ]
 * }
 *
 * Использование:
 *   node scrape.mjs                      # инкрементально: сначала кэш, потом новости
 *   node scrape.mjs --pages 5            # прочитать 5 страниц каталога (по умолчанию 3)
 *   node scrape.mjs --fresh              # просканировать sitemap-fresh.xml (~1400 свежих игр)
 *   node scrape.mjs --all                # ВЕСЬ сайт через все sitemap
 *   node scrape.mjs --all --limit 500    # до 500 НОВЫХ игр за запуск
 *   node scrape.mjs --check-updates --updates-limit 1000 --refresh  # проверка обновлений
 *   node scrape.mjs --time-limit 30      # мягкий лимит времени работы в минутах
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const args = process.argv.slice(2);

const domainArgIdx = args.indexOf("--domain");
const BASE = domainArgIdx !== -1 ? args[domainArgIdx + 1].replace(/\/+$/, "") : "https://itorrents-igruha.net";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const OUT_FILE = "igruha.json";
const CACHE_DIR = ".cache";
const CACHE_FILE = path.join(CACHE_DIR, "downloads.json");

// Лимиты вежливости: сайт не наш, делаем умеренные паузы
const PAGE_DELAY_MS = 1500;
const TORRENT_DELAY_MS = 700;
const MAX_TORRENT_RETRIES = 2;

const FULL = args.includes("--full");
const ALL = args.includes("--all");
const FRESH = args.includes("--fresh");
const CHECK_UPDATES = args.includes("--check-updates");
const REFRESH = args.includes("--refresh");

const limitArgIdx = args.indexOf("--limit");
const ALL_LIMIT = limitArgIdx !== -1 ? parseInt(args[limitArgIdx + 1], 10) || 0 : 0;

const updArgIdx = args.indexOf("--updates-limit");
const UPDATE_LIMIT = updArgIdx !== -1 ? parseInt(args[updArgIdx + 1], 10) || 0 : 0;

const pagesArgIdx = args.indexOf("--pages");
const MAX_PAGES = pagesArgIdx !== -1 ? parseInt(args[pagesArgIdx + 1], 10) || 3 : 3;

const timeLimitArgIdx = args.indexOf("--time-limit");
const TIME_LIMIT_MIN = timeLimitArgIdx !== -1 ? parseInt(args[timeLimitArgIdx + 1], 10) || 0 : 0;
const DEADLINE_MS = TIME_LIMIT_MIN * 60000;
const STARTED_AT = Date.now();
let deadlineReported = false;

function timeExceeded() {
  if (DEADLINE_MS <= 0 || Date.now() - STARTED_AT < DEADLINE_MS) return false;
  if (!deadlineReported) {
    console.log(`[time] лимит ${TIME_LIMIT_MIN} мин достигнут, сохраняем результаты и останавливаемся`);
    deadlineReported = true;
  }
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const win1251Decoder = new TextDecoder("windows-1251");
const utf8Decoder = new TextDecoder("utf-8");

/** fetch с поддержкой windows-1251 и браузерным UA */
async function fetchHtml(url, { encoding = "windows-1251", timeout = 30000, referer = null } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
    };
    if (referer) headers.Referer = referer;

    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return encoding === "windows-1251" ? win1251Decoder.decode(buf) : utf8Decoder.decode(buf);
  } finally {
    clearTimeout(t);
  }
}

/** fetch текста в UTF-8 (для xml sitemap) */
async function fetchXml(url, { timeout = 60000 } = {}) {
  return fetchHtml(url, { encoding: "utf-8", timeout });
}

/**
 * bencode-декодер + поиск info-словаря.
 */
function decodeBencodeAt(buf, offset) {
  const c = buf[offset];
  if (c === 0x64) {
    // 'd' - словарь
    const dict = {};
    let pos = offset + 1;
    while (buf[pos] !== 0x65) {
      const [key, nextPos] = decodeBencodeAt(buf, pos);
      const [val, afterVal] = decodeBencodeAt(buf, nextPos);
      dict[key.toString("latin1")] = val;
      pos = afterVal;
    }
    return [dict, pos + 1];
  }
  if (c === 0x6c) {
    // 'l' - список
    const list = [];
    let pos = offset + 1;
    while (buf[pos] !== 0x65) {
      const [val, nextPos] = decodeBencodeAt(buf, pos);
      list.push(val);
      pos = nextPos;
    }
    return [list, pos + 1];
  }
  if (c === 0x69) {
    // 'i' - целое число
    const end = buf.indexOf(0x65, offset);
    return [parseInt(buf.slice(offset + 1, end).toString(), 10), end + 1];
  }
  // строка: <длина>:<байты>
  const colon = buf.indexOf(0x3a, offset);
  const len = parseInt(buf.slice(offset, colon).toString(), 10);
  const start = colon + 1;
  return [buf.slice(start, start + len), start + len];
}

/** infohash v1 из .torrent (sha1 от bencode-словаря info) */
function computeInfohash(buf) {
  const colon = buf.indexOf(Buffer.from("4:info"));
  if (colon === -1) return null;
  const infoStart = colon + "4:info".length;
  try {
    const [, infoEnd] = decodeBencodeAt(buf, infoStart);
    return createHash("sha1").update(buf.subarray(infoStart, infoEnd)).digest("hex");
  } catch {
    return null;
  }
}

/** Ссылки на игры со страницы каталога */
function extractGameLinks(html) {
  const links = new Set();
  // Ссылки вида https://itorrents-igruha.net/1234-game-name.html или относительные /1234-game-name.html
  const re = /(?:https?:\/\/[^"'>\s/]+)?\/(\d+-[a-z0-9_-]+\.html)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    links.add(`${BASE}/${m[1]}`);
  }
  return [...links];
}

/** Заголовок игры */
function extractTitle(html) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  if (!m) return null;
  return m[1]
    .replace(/^(скачать)\s*/i, "")
    .replace(/торрент\s*на\s*ПК.*$/i, "")
    .replace(/\s*на ПК торрент.*$/i, "")
    .replace(/\s*торрент.*$/i, "")
    .replace(/\s*\(последняя версия[^)]*\)\s*/gi, " ")
    .replace(/\s*\(последняя\)\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([:!?,.;])/g, "$1")
    .trim();
}

/** ID скачивания торрента со страницы игры */
function extractDownloadId(html) {
  // Ищем ?do=download&id=XXXXX или download.php?id=XXXXX
  const m = html.match(/\?do=download&(?:amp;)?id=(\d+)/i) || html.match(/download\.php\?id=(\d+)/i);
  return m ? m[1] : null;
}

/** Размер игры */
function extractSize(html) {
  // На сайте блок: <span class="size-line">Размер: 465 MB v1.2.8 ...</span>
  const mSizeLine = html.match(/Размер:\s*([0-9.,]+\s*(?:МБ|ГБ|КБ|MB|GB|KB))/i);
  if (mSizeLine) return normalizeSize(mSizeLine[1]);

  const mData = html.match(/data-size="([^"]+)"/i) || html.match(/([0-9.,]+\s*(?:МБ|ГБ|КБ|MB|GB|KB))/i);
  if (!mData) return null;
  return normalizeSize(mData[1]);
}

function normalizeSize(s) {
  return s
    .replace(",", ".")
    .replace(/ГБ/i, "GB")
    .replace(/МБ/i, "MB")
    .replace(/КБ/i, "KB")
    .trim();
}

/** Дата обновления/публикации */
const MONTHS = {
  "января": "01", "февраля": "02", "марта": "03", "апреля": "04",
  "мая": "05", "июня": "06", "июля": "07", "августа": "08",
  "сентября": "09", "октября": "10", "ноября": "11", "декабря": "12",
  "янв": "01", "фев": "02", "мар": "03", "апр": "04", "май": "05",
  "июн": "06", "июл": "07", "авг": "08", "сен": "09", "окт": "10",
  "ноя": "11", "дек": "12",
};

function extractDate(html) {
  // 1. Ищем тег <time class="updated" datetime="2026-09-28T11:10:10+03:00">
  const mTime = html.match(/<time[^>]+datetime="([^"]+)"/i);
  if (mTime) {
    const raw = mTime[1]; // 2026-09-28T11:10:10+03:00
    const mIso = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    if (mIso) return `${mIso[1]} ${mIso[2]}`;
  }

  // 2. Текстовая дата
  const mText = html.match(/(\d{1,2})\s+([а-яё]+)\.?\s+(\d{4})(?:[^\d<]*(\d{1,2}:\d{2}))?/i);
  if (mText) {
    const month = MONTHS[mText[2].replace(".", "").toLowerCase()];
    if (month) {
      const day = mText[1].padStart(2, "0");
      const time = mText[4] || "00:00";
      return `${mText[3]}-${month}-${day} ${time}`;
    }
  }

  return null;
}

/** Скачивание .torrent файла */
async function downloadTorrent(downloadId, referer) {
  const url = `${BASE}/engine/download.php?id=${downloadId}`;
  for (let attempt = 0; attempt <= MAX_TORRENT_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Referer: referer,
        },
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 50 || (buf[0] !== 0x64 && !(buf[0] >= 0x30 && buf[0] <= 0x39))) {
        throw new Error("not a valid torrent file");
      }
      return buf;
    } catch (e) {
      if (attempt === MAX_TORRENT_RETRIES) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

async function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/** Получение URL игр из sitemap */
async function loadSitemapUrls({ freshOnly = false } = {}) {
  const urls = new Set();
  const sitemaps = freshOnly
    ? ["sitemap-fresh.xml"]
    : ["sitemap-fresh.xml", "sitemap-games-1.xml", "sitemap-games-2.xml", "sitemap-games-3.xml"];

  for (const sm of sitemaps) {
    process.stdout.write(`sitemap ${sm}... `);
    try {
      const xml = await fetchXml(`${BASE}/${sm}`, { timeout: 120000 });
      const found = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
      const games = found.filter((u) => /\/\d+-[a-z0-9_-]+\.html$/i.test(u));
      games.forEach((u) => urls.add(u));
      console.log(`+${games.length}`);
    } catch (e) {
      console.log(`ошибка: ${e.message}`);
    }
    await sleep(PAGE_DELAY_MS);
  }
  return [...urls];
}

const TRACKERS = [
  "udp://opentor.org:2710",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "http://bt.t-ru.org/ann",
];

function buildMagnet(infohash, title) {
  const trParams = TRACKERS.map((tr) => `&tr=${encodeURIComponent(tr)}`).join("");
  return `magnet:?xt=urn:btih:${infohash}&dn=${encodeURIComponent(title)}${trParams}`;
}

let updatedTorrents = 0;

/** Обработать одну страницу игры: скачал -> infohash -> magnet -> в кэш */
async function processGamePage(link, cache, entries) {
  const alreadyHave = Boolean(cache[link]?.uris?.length);

  if (alreadyHave && (ALL || FRESH) && !FULL) {
    entries.set(link, cache[link]);
    return false;
  }

  await sleep(PAGE_DELAY_MS);
  let gameHtml;
  try {
    gameHtml = await fetchHtml(link);
  } catch (e) {
    console.warn(`  ${link}: ${e.message}`);
    return false;
  }

  const title = extractTitle(gameHtml);
  if (!title) return false;

  const uploadDate = extractDate(gameHtml) || cache[link]?.uploadDate || "";
  const fileSize = extractSize(gameHtml) || cache[link]?.fileSize || "";

  const cached = cache[link];

  // Проверка обновлений
  if (cached?.uris?.length) {
    const fingerprint = `${fileSize}|${uploadDate}|${title}`;
    const cachedFingerprint = `${cached.fileSize}|${cached.uploadDate}|${cached.title}`;
    if (fingerprint === cachedFingerprint) {
      entries.set(link, { ...cached, title, uploadDate, fileSize });
      return false;
    }

    if (!REFRESH) {
      entries.set(link, { ...cached, title, uploadDate, fileSize });
      cache[link] = entries.get(link);
      return false;
    }

    console.log(`  ~ ${title}: обновление на сайте (${cached.fileSize} -> ${fileSize}), перекачиваем...`);
    updatedTorrents++;
  }

  const downloadId = extractDownloadId(gameHtml);
  if (!downloadId) {
    console.warn(`  ${title}: кнопка скачивания не найдена (пропуск)`);
    return false;
  }

  await sleep(TORRENT_DELAY_MS);
  let buf;
  try {
    buf = await downloadTorrent(downloadId, link);
  } catch (e) {
    console.warn(`  ${title}: .torrent не скачался (${e.message})`);
    return false;
  }

  const infohash = computeInfohash(buf);
  if (!infohash) {
    console.warn(`  ${title}: не удалось вычислить infohash`);
    return false;
  }

  const magnet = buildMagnet(infohash, title);
  const entry = {
    title,
    uris: [magnet],
    uploadDate,
    fileSize,
  };

  entries.set(link, entry);
  cache[link] = entry;

  if (cached?.uris?.length) {
    console.log(`  ~ ${title}: magnet обновлен [${infohash}]`);
  } else {
    console.log(`  + ${title} [${infohash}] (${fileSize || "размер не указан"})`);
  }

  return !cached?.uris?.length;
}

async function main() {
  const cache = await loadCache();
  const entries = new Map();
  for (const [url, data] of Object.entries(cache)) {
    entries.set(url, data);
  }

  let pagesRead = 0;
  let newTorrents = 0;
  let skippedByCache = 0;

  // ===== Режим sitemap (--all / --fresh) =====
  if (ALL || FRESH) {
    const gameUrls = await loadSitemapUrls({ freshOnly: FRESH && !ALL });
    const uncachedCount = gameUrls.filter((u) => !cache[u]?.uris?.length || FULL).length;
    const batch = ALL_LIMIT > 0 ? Math.min(ALL_LIMIT, gameUrls.length) : gameUrls.length;
    console.log(`Режим sitemap (${FRESH && !ALL ? "fresh" : "all"}): игр: ${gameUrls.length}, без кэша: ${uncachedCount}, лимит новых: ${batch}`);

    let done = 0;
    let processed = 0;
    for (const link of gameUrls) {
      if (ALL_LIMIT > 0 && processed >= ALL_LIMIT) {
        console.log(`[sitemap] лимит ${ALL_LIMIT} новых игр за запуск достигнут, останавливаемся`);
        break;
      }
      if (timeExceeded()) break;
      done++;
      if (done % 50 === 0) {
        console.log(`[sitemap] прогресс: ${done}/${gameUrls.length} (новых: ${newTorrents})`);
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
      }
      try {
        const isNew = await processGamePage(link, cache, entries);
        if (isNew) {
          newTorrents++;
          processed++;
        } else {
          skippedByCache++;
        }
      } catch (e) {
        console.warn(`  ${link}: ${e.message}`);
      }
    }
  }

  // ===== Режим страниц новостей/каталога =====
  if (!ALL && !FRESH && !CHECK_UPDATES) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (timeExceeded()) break;
      const pageUrl = page === 1 ? `${BASE}/new-pc-games/` : `${BASE}/new-pc-games/page/${page}/`;
      console.log(`[page ${page}] ${pageUrl}`);
      let html;
      try {
        html = await fetchHtml(pageUrl);
      } catch (e) {
        console.warn(`  не удалось загрузить: ${e.message}`);
        if (page === 1) process.exit(1);
        break;
      }
      pagesRead++;

      const gameLinks = extractGameLinks(html);
      console.log(`  найдено игр: ${gameLinks.length}`);

      for (const link of gameLinks) {
        if (timeExceeded()) break;
        if (!FULL && cache[link]?.uris?.length) {
          entries.set(link, cache[link]);
          skippedByCache++;
          continue;
        }

        const isNew = await processGamePage(link, cache, entries);
        if (isNew) newTorrents++;
      }
    }
  }

  // ===== Проверка обновлений (--check-updates) =====
  if (CHECK_UPDATES) {
    const gameUrls = await loadSitemapUrls({ freshOnly: true });
    const cachedUrls = gameUrls.filter((u) => cache[u]?.uris?.length);
    const slice = UPDATE_LIMIT > 0 ? cachedUrls.slice(0, UPDATE_LIMIT) : cachedUrls;
    console.log(`\n[check-updates] игр в кэше: ${cachedUrls.length}, проверяем за запуск: ${slice.length}`);

    let checked = 0;
    for (const link of slice) {
      if (timeExceeded()) break;
      checked++;
      if (checked % 50 === 0) {
        console.log(`[check-updates] прогресс: ${checked}/${slice.length} (обновлено: ${updatedTorrents})`);
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
      }
      try {
        await processGamePage(link, cache, entries);
      } catch (e) {
        console.warn(`  ${link}: ${e.message}`);
      }
    }
    console.log(`[check-updates] проверено: ${checked}, обновлено: ${updatedTorrents}`);
  }

  // Собираем итоговый JSON
  const downloads = [...entries.values()]
    .filter((d) => d.uris?.length)
    .sort((a, b) => (b.uploadDate || "").localeCompare(a.uploadDate || ""));

  const json = {
    name: "Torrent Igruha",
    downloads,
  };

  await writeFile(OUT_FILE, JSON.stringify(json, null, 2), "utf-8");
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");

  console.log(
    `\nГотово. Страниц прочитано: ${pagesRead}. В кэше: ${skippedByCache}. Новых торрентов: ${newTorrents}.`
  );
  console.log(`Записей в итоговом файле: ${downloads.length} -> ${OUT_FILE}`);
}

const isMain =
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` ||
    process.argv[1].endsWith("scrape.mjs"));

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export {
  extractDownloadId,
  extractGameLinks,
  extractTitle,
  extractSize,
  extractDate,
  computeInfohash,
  buildMagnet,
};
