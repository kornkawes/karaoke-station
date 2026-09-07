import { AppError } from "./errors.js";
import { cloneJson, createAbortController, defaultFetch } from "./compat.js";
import { youtubeIdSchema } from "./schemas.js";

const SEARCH_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtube-nocookie.com"
]);
const THUMBNAIL_HOSTS = new Set(["i.ytimg.com", "img.youtube.com"]);
const MODE_SUFFIX = {
  none: "",
  karaoke: " karaoke",
  instrumental: " instrumental",
  backing: " backing track",
  both: " karaoke | instrumental | backing track | คาราโอเกะ"
};
const CLASSIFICATION = {
  karaoke: { classification: "karaoke", badge: "Karaoke" },
  instrumental: { classification: "instrumental", badge: "Instrumental" },
  backing: { classification: "backing_track", badge: "Backing Track" }
};
const POSITIVE_KEYWORDS = [
  { mode: "backing", pattern: /backing[\s_-]*track/iu },
  { mode: "instrumental", pattern: /instrumental/iu },
  { mode: "karaoke", pattern: /karaoke|คาราโอเกะ/iu }
];
const NEGATIVE_TITLE = /official\s+(?:music\s+video|mv)|reaction|vocal\s+cover|live\s+performance/iu;

function isYouTubeHost(hostname) {
  return YOUTUBE_HOSTS.has(hostname.toLowerCase());
}

function thumbnailUrl(value, videoId) {
  const fallback = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  try {
    const url = new URL(String(value || fallback));
    if (url.protocol === "https:" && THUMBNAIL_HOSTS.has(url.hostname.toLowerCase())) {
      return url.toString();
    }
  } catch {
    // Use the known-safe YouTube thumbnail below.
  }
  return fallback;
}

function text(value, fallback = "", maxLength = 300) {
  const valueText = String(value ?? fallback).trim();
  return valueText.slice(0, maxLength) || fallback;
}

export function parseYouTubeInput(input) {
  const value = String(input ?? "").trim();
  const directId = youtubeIdSchema.safeParse(value);
  if (directId.success) return { videoId: directId.data, canonicalUrl: `https://www.youtube.com/watch?v=${directId.data}` };

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, "invalid_youtube_url", "กรุณาใส่ลิงก์ YouTube หรือ video ID ที่ถูกต้อง");
  }
  if (url.protocol !== "https:" || !isYouTubeHost(url.hostname)) {
    throw new AppError(400, "invalid_youtube_url", "รองรับเฉพาะลิงก์ HTTPS จาก YouTube");
  }

  let videoId;
  if (url.hostname === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0];
  } else if (url.pathname === "/watch") {
    videoId = url.searchParams.get("v");
  } else {
    const [kind, id] = url.pathname.split("/").filter(Boolean);
    if (["embed", "shorts", "live"].includes(kind)) videoId = id;
  }
  const parsed = youtubeIdSchema.safeParse(videoId);
  if (!parsed.success) {
    throw new AppError(400, "invalid_youtube_url", "ไม่พบ video ID ที่ถูกต้องในลิงก์ YouTube");
  }
  return {
    videoId: parsed.data,
    canonicalUrl: `https://www.youtube.com/watch?v=${parsed.data}`
  };
}

export function classifyKaraokeTrack({ title = "", description = "" } = {}) {
  const normalizedTitle = String(title).normalize("NFKC");
  for (const candidate of POSITIVE_KEYWORDS) {
    if (candidate.pattern.test(normalizedTitle)) return CLASSIFICATION[candidate.mode];
  }
  if (NEGATIVE_TITLE.test(normalizedTitle)) return null;
  const normalizedDescription = String(description).normalize("NFKC");
  for (const candidate of POSITIVE_KEYWORDS) {
    if (candidate.pattern.test(normalizedDescription)) return CLASSIFICATION[candidate.mode];
  }
  return null;
}

async function fetchJson(fetchImpl, url, { timeoutMs, headers } = {}) {
  const controller = createAbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers });
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const reason = body?.error?.errors?.[0]?.reason;
      if (response.status === 429 || ["quotaExceeded", "dailyLimitExceeded"].includes(reason)) {
        throw new AppError(429, "youtube_quota_exceeded", "โควตาค้นหา YouTube หมดชั่วคราว");
      }
      if (["keyInvalid", "accessNotConfigured", "ipRefererBlocked"].includes(reason)) {
        throw new AppError(503, "youtube_credentials_invalid", "YouTube API key ใช้งานไม่ได้หรือถูกจำกัดไม่ถูกต้อง");
      }
      throw new AppError(502, "youtube_upstream_error", "YouTube ตอบกลับผิดพลาด", {
        upstreamStatus: response.status,
        reason
      });
    }
    return body;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError(504, "youtube_timeout", "YouTube ใช้เวลาตอบกลับนานเกินไป");
    }
    if (error instanceof AppError) throw error;
    throw new AppError(502, "youtube_unavailable", "เชื่อมต่อ YouTube ไม่สำเร็จ");
  } finally {
    clearTimeout(timeout);
  }
}

export class YouTubeService {
  constructor({ fetchImpl = defaultFetch(), getApiKey, timeoutMs = 8_000, cacheTtlMs = 24 * 60 * 60 * 1_000 }) {
    this.fetchImpl = fetchImpl;
    this.getApiKey = getApiKey;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();
    this.resolveInFlight = new Map();
  }

  async search({ query, mode = "both", maxResults = 12 }) {
    const trimmed = String(query ?? "").trim();
    if (!trimmed || trimmed.length > 120) {
      throw new AppError(400, "invalid_search_query", "คำค้นต้องมี 1–120 ตัวอักษร");
    }
    if (!(mode in MODE_SUFFIX)) {
      throw new AppError(400, "invalid_search_mode", "โหมดค้นหาไม่ถูกต้อง");
    }
    const count = Math.min(Math.max(Number(maxResults) || 12, 1), 25);
    const cacheKey = `${mode}:${trimmed.toLocaleLowerCase("th")}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        ...cloneJson(cached.value),
        results: cloneJson(cached.value.results.slice(0, count)),
        cached: true
      };
    }

    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new AppError(
        503,
        "youtube_not_configured",
        "ยังไม่ได้ตั้งค่า YouTube API key — ยังใช้การวางลิงก์ YouTube ได้"
      );
    }
    const searchUrl = new URL(SEARCH_ENDPOINT);
    searchUrl.search = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      videoSyndicated: "true",
      safeSearch: "moderate",
      maxResults: String(Math.max(count, 25)),
      q: `${trimmed}${MODE_SUFFIX[mode]}`,
      key: apiKey
    });
    const searchBody = await fetchJson(this.fetchImpl, searchUrl, { timeoutMs: this.timeoutMs });
    const ids = (searchBody?.items ?? [])
      .map((item) => item?.id?.videoId)
      .filter((id) => youtubeIdSchema.safeParse(id).success);
    if (!ids.length) {
      const value = { query: trimmed, mode, results: [] };
      this.cache.set(cacheKey, { value, expiresAt: Date.now() + this.cacheTtlMs });
      if (this.cache.size > 1_000) this.cache.delete(this.cache.keys().next().value);
      return { ...cloneJson(value), cached: false };
    }

    const videosUrl = new URL(VIDEOS_ENDPOINT);
    videosUrl.search = new URLSearchParams({
      part: "snippet,contentDetails,status",
      id: ids.join(","),
      key: apiKey
    });
    const videosBody = await fetchJson(this.fetchImpl, videosUrl, { timeoutMs: this.timeoutMs });
    const byId = new Map((videosBody?.items ?? []).map((item) => [item.id, item]));
    const results = ids.flatMap((id) => {
      const item = byId.get(id);
      if (!item || item.status?.embeddable === false || item.status?.privacyStatus !== "public") return [];
      const classification = classifyKaraokeTrack({
        title: item.snippet?.title,
        description: item.snippet?.description
      });
      if (mode !== "none") {
        const expected = mode === "both"
          ? null
          : CLASSIFICATION[mode]?.classification;
        if (!classification || (expected && classification.classification !== expected)) return [];
      }
      const thumbnail = thumbnailUrl(
        item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url,
        id
      );
      return [{
        videoId: id,
        title: text(item.snippet?.title, "Untitled"),
        channelTitle: text(item.snippet?.channelTitle, "", 200),
        thumbnailUrl: thumbnail,
        duration: item.contentDetails?.duration ?? null,
        ...(classification ?? { classification: null, badge: null }),
        embeddable: true,
        canonicalUrl: `https://www.youtube.com/watch?v=${id}`
      }];
    });
    const value = { query: trimmed, mode, results };
    this.cache.set(cacheKey, { value, expiresAt: Date.now() + this.cacheTtlMs });
    if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value);
    return {
      ...cloneJson(value),
      results: cloneJson(value.results.slice(0, count)),
      cached: false
    };
  }

  async resolveVideo({ input }) {
    const { videoId, canonicalUrl } = parseYouTubeInput(input);
    const cacheKey = `video:${videoId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cloneJson(cached.value), cached: true };
    }

    const inFlight = this.resolveInFlight.get(cacheKey);
    if (inFlight) {
      const value = await inFlight;
      return { ...cloneJson(value), cached: true };
    }

    const resolution = (async () => {
      const apiKey = this.getApiKey ? this.getApiKey() : null;
      let apiError = null;

      if (apiKey) {
        try {
          const videosUrl = new URL(VIDEOS_ENDPOINT);
          videosUrl.search = new URLSearchParams({
            part: "snippet,contentDetails,status",
            id: videoId,
            key: apiKey
          });
          const videosBody = await fetchJson(this.fetchImpl, videosUrl, { timeoutMs: this.timeoutMs });
          const item = videosBody?.items?.[0];
          if (!item || item.status?.embeddable === false || item.status?.privacyStatus !== "public") {
            throw new AppError(404, "youtube_video_unavailable", "วิดีโอนี้ไม่พร้อมให้เล่นในห้องนี้");
          }
          const classification = classifyKaraokeTrack({
            title: item.snippet?.title,
            description: item.snippet?.description
          });
          return {
            videoId,
            title: text(item.snippet?.title, "YouTube Video"),
            channelTitle: text(item.snippet?.channelTitle, "", 200),
            thumbnailUrl: thumbnailUrl(
              item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url,
              videoId
            ),
            duration: item.contentDetails?.duration ?? null,
            ...(classification ?? { classification: "karaoke", badge: "Karaoke" }),
            embeddable: true,
            canonicalUrl
          };
        } catch (error) {
          // Quota, credential, or transient errors can still use zero-quota
          // oEmbed. A successful API response that says the video is private or
          // unembeddable must never be bypassed by that fallback.
          if (error?.code === "youtube_video_unavailable") throw error;
          apiError = error;
        }
      }

      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;
        const oembedData = await fetchJson(this.fetchImpl, oembedUrl, { timeoutMs: this.timeoutMs });
        if (!oembedData?.title) {
          throw new AppError(404, "youtube_video_unavailable", "วิดีโอนี้ไม่พร้อมให้เล่นในห้องนี้");
        }
        const classification = classifyKaraokeTrack({ title: oembedData.title });
        return {
          videoId,
          title: text(oembedData.title, "YouTube Video"),
          channelTitle: text(oembedData.author_name, "YouTube", 200),
          thumbnailUrl: thumbnailUrl(oembedData.thumbnail_url, videoId),
          duration: null,
          ...(classification ?? { classification: "karaoke", badge: "Karaoke" }),
          embeddable: true,
          canonicalUrl
        };
      } catch (error) {
        // Preserve the useful API error (quota/credentials/timeout) when both
        // metadata sources fail, without exposing upstream response data.
        throw apiError || error;
      }
    })();

    this.resolveInFlight.set(cacheKey, resolution);
    try {
      const track = await resolution;
      this.cache.set(cacheKey, { value: track, expiresAt: Date.now() + this.cacheTtlMs });
      if (this.cache.size > 1_000) this.cache.delete(this.cache.keys().next().value);
      return { ...cloneJson(track), cached: false };
    } finally {
      if (this.resolveInFlight.get(cacheKey) === resolution) this.resolveInFlight.delete(cacheKey);
    }
  }
}
