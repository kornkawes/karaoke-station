import { AppError } from "./errors.js";

const KARAOKE_DECORATION = /\s*(?:[\[(【].*?(?:karaoke|instrumental|backing\s*track|คาราโอเกะ).*?[\])】]|[-–—|]\s*(?:karaoke|instrumental|backing\s*track|คาราโอเกะ).*)$/iu;

function fold(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("th")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeSongQuery(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(KARAOKE_DECORATION, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
}

export class SuggestionService {
  constructor({ getState, maxRecent = 50 }) {
    this.getState = getState;
    this.maxRecent = maxRecent;
    this.recent = [];
  }

  remember(query) {
    const text = normalizeSongQuery(query);
    if (!text) return;
    const key = fold(text);
    this.recent = [text, ...this.recent.filter((item) => fold(item) !== key)]
      .slice(0, this.maxRecent);
  }

  list({ query = "", limit = 8 } = {}) {
    const text = String(query ?? "").trim();
    if (text.length > 120) {
      throw new AppError(400, "invalid_suggestion_query", "คำค้นแนะนำยาวเกิน 120 ตัวอักษร");
    }
    const count = Math.min(Math.max(Number(limit) || 8, 1), 20);
    const needle = fold(text);
    const state = this.getState();
    const candidates = [
      ...this.recent.map((value, index) => ({ text: value, source: "recent", rank: index })),
      ...state.queue.map((track, index) => ({ text: track.title, source: "queue", rank: index })),
      ...(state.current ? [{ text: state.current.title, source: "queue", rank: -1 }] : []),
      ...state.favorites.map((track, index) => ({ text: track.title, source: "favorite", rank: index })),
      ...state.history.map((track, index) => ({ text: track.title, source: "history", rank: index }))
    ];
    const seen = new Set();
    const suggestions = candidates
      .map((candidate) => ({ ...candidate, text: normalizeSongQuery(candidate.text) }))
      .filter((candidate) => {
        const key = fold(candidate.text);
        if (!key || seen.has(key) || (needle && !key.includes(needle))) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => {
        if (!needle) return 0;
        const aPrefix = fold(a.text).startsWith(needle) ? 0 : 1;
        const bPrefix = fold(b.text).startsWith(needle) ? 0 : 1;
        return aPrefix - bPrefix || a.rank - b.rank;
      })
      .slice(0, count)
      .map(({ text: suggestionText, source }) => ({ text: suggestionText, source }));
    return { query: text, suggestions };
  }
}
