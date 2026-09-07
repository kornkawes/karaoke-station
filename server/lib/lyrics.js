import { AppError } from "./errors.js";
import { createAbortController, defaultFetch } from "./compat.js";

const LRCLIB_ENDPOINT = "https://lrclib.net/api/search";

export class LyricsService {
  constructor({ fetchImpl = defaultFetch(), timeoutMs = 6_000 }) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async search({ trackName, artistName = "", albumName = "" }) {
    const track = String(trackName ?? "").trim();
    const artist = String(artistName ?? "").trim();
    const album = String(albumName ?? "").trim();
    if (!track || track.length > 300 || artist.length > 200 || album.length > 200) {
      throw new AppError(400, "invalid_lyrics_query", "ข้อมูลค้นหาเนื้อร้องไม่ถูกต้อง");
    }
    const url = new URL(LRCLIB_ENDPOINT);
    url.search = new URLSearchParams({
      track_name: track,
      ...(artist ? { artist_name: artist } : {}),
      ...(album ? { album_name: album } : {})
    });
    const controller = createAbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { "User-Agent": "KaraokeStation/0.1 (local-first karaoke app)" }
      });
      if (response.status === 429) {
        throw new AppError(429, "lyrics_rate_limited", "ผู้ให้บริการเนื้อร้องจำกัดการค้นหาชั่วคราว");
      }
      if (!response.ok) {
        throw new AppError(502, "lyrics_upstream_error", "ผู้ให้บริการเนื้อร้องตอบกลับผิดพลาด");
      }
      const body = await response.json();
      if (!Array.isArray(body)) {
        throw new AppError(502, "lyrics_invalid_response", "รูปแบบข้อมูลเนื้อร้องไม่ถูกต้อง");
      }
      return body.slice(0, 10).flatMap((item) => {
        if (
          typeof item?.trackName !== "string" ||
          typeof item?.artistName !== "string" ||
          (!item.plainLyrics && !item.syncedLyrics)
        ) return [];
        return [{
          providerId: String(item.id),
          trackName: item.trackName.slice(0, 300),
          artistName: item.artistName.slice(0, 200),
          albumName: typeof item.albumName === "string" ? item.albumName.slice(0, 200) : "",
          duration: Number.isFinite(item.duration) ? item.duration : null,
          kind: item.syncedLyrics ? "lrc" : "plain",
          content: String(item.syncedLyrics || item.plainLyrics).slice(0, 100_000),
          source: "lrclib"
        }];
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new AppError(504, "lyrics_timeout", "ค้นหาเนื้อร้องใช้เวลานานเกินไป");
      }
      if (error instanceof AppError) throw error;
      throw new AppError(502, "lyrics_unavailable", "เชื่อมต่อผู้ให้บริการเนื้อร้องไม่สำเร็จ");
    } finally {
      clearTimeout(timeout);
    }
  }
}
