import { createSign } from "node:crypto";
import { AppError } from "./errors.js";
import { createAbortController, defaultFetch } from "./compat.js";
import { youtubeIdSchema } from "./schemas.js";
import { parseYouTubeInput } from "./youtube.js";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_RANGE = "Catalog!A:I";
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const MAX_SUGGESTIONS = 30;

const FIXED_COLUMNS = [
  "artist",
  "title",
  "videoId",
  "channelTitle",
  "thumbnailUrl",
  "classification",
  "badge",
  "youtubeUrl",
  "aliases"
];

const HEADER_ALIASES = new Map([
  ["artist", "artist"],
  ["artistname", "artist"],
  ["singer", "artist"],
  ["ศิลปิน", "artist"],
  ["นักร้อง", "artist"],
  ["title", "title"],
  ["song", "title"],
  ["songtitle", "title"],
  ["name", "title"],
  ["ชื่อเพลง", "title"],
  ["videoid", "videoId"],
  ["youtubeid", "videoId"],
  ["youtubevideoid", "videoId"],
  ["id", "videoId"],
  ["youtubeurl", "youtubeUrl"],
  ["url", "youtubeUrl"],
  ["link", "youtubeUrl"],
  ["youtubelink", "youtubeUrl"],
  ["aliases", "aliases"],
  ["alias", "aliases"],
  ["aka", "aliases"],
  ["keywords", "aliases"],
  ["searchaliases", "aliases"],
  ["คำค้น", "aliases"],
  ["channeltitle", "channelTitle"],
  ["channel", "channelTitle"],
  ["youtubechannel", "channelTitle"],
  ["thumbnailurl", "thumbnailUrl"],
  ["thumbnail", "thumbnailUrl"],
  ["image", "thumbnailUrl"],
  ["classification", "classification"],
  ["type", "classification"],
  ["badge", "badge"]
]);

const CLASSIFICATION_BADGES = {
  karaoke: "Karaoke",
  instrumental: "Instrumental",
  backing_track: "Backing Track"
};

function cleanText(value, maxLength) {
  return String(value ?? "").normalize("NFKC").trim().slice(0, maxLength);
}

function normalizeHeader(value) {
  return cleanText(value, 100)
    .toLocaleLowerCase("th")
    .replace(/[\s_-]+/gu, "");
}

function headerColumns(row) {
  const columns = row.map((value) => HEADER_ALIASES.get(normalizeHeader(value)) ?? null);
  const recognized = new Set(columns.filter(Boolean));
  return recognized.has("title") && (recognized.has("videoId") || recognized.has("youtubeUrl"))
    ? columns
    : null;
}

function safeThumbnail(value) {
  const text = cleanText(value, 2_000);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (
      url.protocol === "https:" &&
      ["i.ytimg.com", "img.youtube.com"].includes(url.hostname.toLowerCase())
    ) {
      return url.toString();
    }
  } catch {
    // Invalid optional metadata is omitted; it must not invalidate the song.
  }
  return undefined;
}

function normalizeAliases(value) {
  let candidates = value;
  if (typeof candidates === "string") {
    const trimmed = candidates.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) candidates = parsed;
      } catch {
        // Fall back to the delimiter-separated form below.
      }
    }
    if (typeof candidates === "string") candidates = candidates.split(/[\n,;|]+/u);
  }
  if (!Array.isArray(candidates)) return [];
  return [...new Set(candidates.map((alias) => cleanText(alias, 100)).filter(Boolean))].slice(0, 20);
}

export function normalizeCatalogTrack(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  let parsedYouTube = null;
  try {
    if (input.youtubeUrl) parsedYouTube = parseYouTubeInput(cleanText(input.youtubeUrl, 2_000));
  } catch {
    // A valid explicit videoId remains usable when optional URL metadata is bad.
  }
  // A sheet may expose either videoId or youtubeUrl. Empty/invalid values in an
  // optional videoId column must not mask a valid URL in the same row.
  const explicitVideoId = youtubeIdSchema.safeParse(cleanText(input.videoId, 32));
  const videoId = explicitVideoId.success
    ? explicitVideoId
    : youtubeIdSchema.safeParse(cleanText(parsedYouTube?.videoId, 32));
  const title = cleanText(input.title, 300);
  if (!videoId.success || !title) return null;

  const classification = Object.hasOwn(CLASSIFICATION_BADGES, input.classification)
    ? input.classification
    : null;
  const expectedBadge = classification ? CLASSIFICATION_BADGES[classification] : null;
  const suppliedBadge = cleanText(input.badge, 32);
  const badge = classification && (!suppliedBadge || suppliedBadge === expectedBadge)
    ? expectedBadge
    : null;
  const thumbnailUrl = safeThumbnail(input.thumbnailUrl);
  const aliases = normalizeAliases(input.aliases);

  const channelTitle = cleanText(input.channelTitle, 200);
  return {
    // Auto-learned YouTube tracks do not always carry a separate artist field;
    // retaining the channel as the artist keeps the required catalog column
    // useful while preserving channelTitle for the UI.
    artist: cleanText(input.artist, 200) || channelTitle,
    title,
    videoId: videoId.data,
    youtubeUrl: `https://www.youtube.com/watch?v=${videoId.data}`,
    aliases,
    ...(channelTitle
      ? { channelTitle }
      : {}),
    ...(thumbnailUrl
      ? { thumbnailUrl }
      : {}),
    ...(classification && badge ? { classification, badge } : {})
  };
}

function rowsWithColumns(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { columns: FIXED_COLUMNS, startIndex: 0 };
  }
  const headers = Array.isArray(rows[0]) ? headerColumns(rows[0]) : null;
  return headers
    ? { columns: headers, startIndex: 1 }
    : { columns: FIXED_COLUMNS, startIndex: 0 };
}

/** Convert a Sheets values payload (header row optional) into safe public tracks. */
export function mapCatalogRows(rows) {
  if (!Array.isArray(rows)) return [];
  const { columns, startIndex } = rowsWithColumns(rows);
  const seen = new Set();
  const items = [];
  for (const row of rows.slice(startIndex)) {
    let candidate;
    if (Array.isArray(row)) {
      candidate = {};
      columns.forEach((column, index) => {
        if (column) candidate[column] = row[index];
      });
    } else {
      candidate = row;
    }
    const track = normalizeCatalogTrack(candidate);
    if (!track || seen.has(track.videoId)) continue;
    seen.add(track.videoId);
    items.push(track);
  }
  return items;
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function serviceAccountFromEnv(env) {
  let fromJson = {};
  const json = cleanText(env.GOOGLE_SERVICE_ACCOUNT_JSON, 50_000);
  if (json) {
    try {
      fromJson = JSON.parse(json);
    } catch {
      // Keep startup available. The source will remain unconfigured rather than
      // throwing while the process boots.
      fromJson = {};
    }
  }
  const email = cleanText(
    fromJson.client_email ?? env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? env.GOOGLE_SHEETS_CLIENT_EMAIL,
    500
  );
  const privateKey = String(
    fromJson.private_key ?? env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ?? env.GOOGLE_SHEETS_PRIVATE_KEY ?? ""
  ).replace(/\\n/gu, "\n").trim();
  return email && privateKey ? { email, privateKey } : null;
}

async function fetchJson(fetchImpl, url, options, { timeoutMs, errorCode }) {
  const controller = createAbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    let body = null;
    try {
      body = await response.json();
    } catch {
      // An upstream HTML/error body is never returned to clients.
    }
    if (!response.ok) {
      throw new AppError(502, errorCode, "เชื่อมต่อคลังเพลงไม่สำเร็จ", {
        upstreamStatus: response.status
      });
    }
    return body;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error?.name === "AbortError") {
      throw new AppError(504, "catalog_timeout", "คลังเพลงใช้เวลาตอบกลับนานเกินไป");
    }
    throw new AppError(502, errorCode, "เชื่อมต่อคลังเพลงไม่สำเร็จ");
  } finally {
    clearTimeout(timeout);
  }
}

export class GoogleSheetsCatalogSource {
  constructor({
    spreadsheetId,
    range = DEFAULT_RANGE,
    credentials,
    fetchImpl = defaultFetch(),
    now = () => Date.now(),
    timeoutMs = 8_000
  }) {
    this.spreadsheetId = cleanText(spreadsheetId, 500);
    this.range = cleanText(range, 500) || DEFAULT_RANGE;
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.accessToken = null;
    this.tokenInFlight = null;
    this.columns = FIXED_COLUMNS;
  }

  async getAccessToken() {
    if (this.accessToken?.expiresAt > this.now() + 30_000) return this.accessToken.value;
    if (this.tokenInFlight) return this.tokenInFlight;
    this.tokenInFlight = this.requestAccessToken();
    try {
      return await this.tokenInFlight;
    } finally {
      this.tokenInFlight = null;
    }
  }

  async requestAccessToken() {
    const issuedAt = Math.floor(this.now() / 1_000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64Url(JSON.stringify({
      iss: this.credentials.email,
      scope: GOOGLE_SHEETS_SCOPE,
      aud: GOOGLE_TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + 3_600
    }));
    const unsigned = `${header}.${claims}`;
    let signature;
    try {
      signature = createSign("RSA-SHA256").update(unsigned).end().sign(this.credentials.privateKey);
    } catch {
      throw new AppError(503, "catalog_credentials_invalid", "ตั้งค่าคลังเพลงไม่ถูกต้อง");
    }
    const assertion = `${unsigned}.${base64Url(signature)}`;
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    });
    const result = await fetchJson(this.fetchImpl, GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    }, { timeoutMs: this.timeoutMs, errorCode: "catalog_auth_failed" });
    const token = cleanText(result?.access_token, 4_096);
    if (!token) {
      throw new AppError(502, "catalog_auth_failed", "เชื่อมต่อคลังเพลงไม่สำเร็จ");
    }
    const expiresIn = Math.min(Math.max(Number(result?.expires_in) || 3_600, 60), 3_600);
    this.accessToken = { value: token, expiresAt: this.now() + expiresIn * 1_000 };
    return token;
  }

  valuesUrl(suffix = "") {
    const sheetId = encodeURIComponent(this.spreadsheetId);
    const range = encodeURIComponent(this.range);
    return `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}${suffix}`;
  }

  async load() {
    const token = await this.getAccessToken();
    const body = await fetchJson(this.fetchImpl, this.valuesUrl(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    }, { timeoutMs: this.timeoutMs, errorCode: "catalog_read_failed" });
    const rows = Array.isArray(body?.values) ? body.values : [];
    this.columns = rowsWithColumns(rows).columns;
    return rows;
  }

  async append(track) {
    const token = await this.getAccessToken();
    const row = this.columns.map((column) => {
      if (!column) return "";
      if (column === "aliases") return (track.aliases ?? []).join(" | ");
      return track[column] ?? "";
    });
    const params = new URLSearchParams({
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS"
    });
    await fetchJson(this.fetchImpl, this.valuesUrl(`:append?${params}`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ majorDimension: "ROWS", values: [row] })
    }, { timeoutMs: this.timeoutMs, errorCode: "catalog_append_failed" });
  }
}

export function createCatalogSourceFromEnv(env = process.env, { fetchImpl, now } = {}) {
  const spreadsheetId = cleanText(
    env.GOOGLE_SHEETS_ID ?? env.GOOGLE_SHEETS_SPREADSHEET_ID,
    500
  );
  const credentials = serviceAccountFromEnv(env);
  if (!spreadsheetId || !credentials) return null;
  return new GoogleSheetsCatalogSource({
    spreadsheetId,
    range: env.GOOGLE_SHEETS_RANGE || DEFAULT_RANGE,
    credentials,
    fetchImpl,
    now
  });
}

function searchText(track) {
  return [track.artist, track.title, track.channelTitle, ...(track.aliases ?? [])]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase("th");
}

export class CatalogService {
  constructor({ source = null, cacheTtlMs = DEFAULT_CACHE_TTL_MS, now = () => Date.now() } = {}) {
    this.source = source;
    this.cacheTtlMs = Math.max(Number(cacheTtlMs) || DEFAULT_CACHE_TTL_MS, 1_000);
    this.now = now;
    this.cache = { items: [], expiresAt: 0, loaded: false };
    this.loadInFlight = null;
    this.appendInFlight = new Map();
    this.knownVideoIds = new Set();
  }

  async load({ force = false } = {}) {
    if (!this.source) return [];
    if (!force && this.cache.loaded && this.cache.expiresAt > this.now()) return this.cache.items;
    if (this.loadInFlight) return this.loadInFlight;
    this.loadInFlight = (async () => {
      try {
        const rows = await this.source.load();
        const items = mapCatalogRows(rows);
        this.cache = { items, expiresAt: this.now() + this.cacheTtlMs, loaded: true };
        this.knownVideoIds = new Set(items.map((item) => item.videoId));
        return items;
      } catch (error) {
        // An expired cache is still more useful than breaking suggestions during
        // a temporary Google outage. With no prior data, surface the real failure.
        if (this.cache.loaded) return this.cache.items;
        throw error;
      }
    })();
    try {
      return await this.loadInFlight;
    } finally {
      this.loadInFlight = null;
    }
  }

  async listSuggestions({ query = "", limit = 8 } = {}) {
    const text = cleanText(query, 121);
    if (String(query ?? "").trim().length > 120) {
      throw new AppError(400, "invalid_catalog_query", "คำค้นแนะนำยาวเกิน 120 ตัวอักษร");
    }
    const numericLimit = Number(limit);
    if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > MAX_SUGGESTIONS) {
      throw new AppError(400, "invalid_catalog_limit", `จำนวนคำแนะนำต้องอยู่ระหว่าง 1–${MAX_SUGGESTIONS}`);
    }
    const items = await this.load();
    const normalizedQuery = text.normalize("NFKC").toLocaleLowerCase("th");
    const tokens = normalizedQuery.split(/\s+/u).filter(Boolean);
    return {
      suggestions: items
        .filter((track) => {
          const candidate = searchText(track);
          return tokens.every((token) => candidate.includes(token));
        })
        .slice(0, numericLimit)
    };
  }

  async remember(input) {
    if (!this.source) return false;
    const track = normalizeCatalogTrack(input);
    if (!track) return false;
    if (this.appendInFlight.has(track.videoId)) return this.appendInFlight.get(track.videoId);

    const operation = (async () => {
      await this.load();
      if (this.knownVideoIds.has(track.videoId)) return false;
      await this.source.append(track);
      this.knownVideoIds.add(track.videoId);
      this.cache = {
        items: [...this.cache.items, track],
        expiresAt: this.now() + this.cacheTtlMs,
        loaded: true
      };
      return true;
    })();
    this.appendInFlight.set(track.videoId, operation);
    try {
      return await operation;
    } finally {
      if (this.appendInFlight.get(track.videoId) === operation) {
        this.appendInFlight.delete(track.videoId);
      }
    }
  }
}
