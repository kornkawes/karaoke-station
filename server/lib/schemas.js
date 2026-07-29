import { randomInt } from "node:crypto";
import { z } from "zod";

const youtubeIdPattern = /^[A-Za-z0-9_-]{11}$/;

export const youtubeIdSchema = z.string().regex(youtubeIdPattern, "Invalid YouTube video ID");

export const trackClassificationSchema = z.enum(["karaoke", "instrumental", "backing_track"]);
export const trackBadgeSchema = z.enum(["Karaoke", "Instrumental", "Backing Track"]);

const TRACK_BADGES = {
  karaoke: "Karaoke",
  instrumental: "Instrumental",
  backing_track: "Backing Track"
};

export const trackInputSchema = z.object({
  videoId: youtubeIdSchema,
  title: z.string().trim().min(1).max(300),
  channelTitle: z.string().trim().max(200).default(""),
  thumbnailUrl: z.string().url().max(2_000).refine(
    (value) => {
      const url = new URL(value);
      return url.protocol === "https:" && ["i.ytimg.com", "img.youtube.com"].includes(url.hostname);
    },
    "Thumbnail must use an approved YouTube host"
  ).optional(),
  duration: z.string().max(32).optional(),
  classification: trackClassificationSchema.nullable().optional().default(null),
  badge: trackBadgeSchema.nullable().optional().default(null),
  requestedBy: z.string().trim().min(2).max(20).optional()
}).strict().superRefine((track, context) => {
  if (
    (track.classification === null) !== (track.badge === null) ||
    (track.classification && TRACK_BADGES[track.classification] !== track.badge)
  ) {
    context.addIssue({
      code: "custom",
      path: ["badge"],
      message: "Track classification and badge do not match"
    });
  }
});

export const queueAddSchema = z.object({
  track: trackInputSchema,
  playNow: z.boolean().default(false),
  allowDuplicate: z.boolean().optional()
}).strict();

export const reorderSchema = z.object({
  itemId: z.string().uuid(),
  toIndex: z.number().int().min(0),
  revision: z.number().int().nonnegative().optional()
}).strict();

export const partyRevisionSchema = z.object({
  revision: z.number().int().nonnegative()
}).strict();

export const partyPlayNowSchema = z.object({
  itemId: z.string().uuid(),
  revision: z.number().int().nonnegative()
}).strict();

export const queueFailureSchema = z.object({
  reason: z.enum(["embed_disabled", "private", "region_restricted", "player_error", "network"]),
  message: z.string().trim().max(300).optional()
}).strict();

export const favoriteSchema = trackInputSchema.refine(
  (track) => track.requestedBy === undefined,
  { message: "requestedBy is not accepted for favorites", path: ["requestedBy"] }
);

export const lyricSchema = z.object({
  videoId: youtubeIdSchema,
  kind: z.enum(["plain", "lrc"]).default("plain"),
  content: z.string().min(1).max(100_000),
  source: z.enum(["manual", "lrclib"]).default("manual"),
  trackName: z.string().trim().max(300).optional(),
  artistName: z.string().trim().max(200).optional()
}).strict();

export const settingsPatchSchema = z.object({
  stationName: z.string().trim().min(1).max(60).optional(),
  language: z.enum(["th", "en"]).optional(),
  theme: z.enum(["dark", "high-contrast"]).optional(),
  autoplayNext: z.boolean().optional(),
  confirmPlayNow: z.boolean().optional(),
  defaultVolume: z.number().int().min(0).max(100).optional(),
  defaultLyricsMode: z.enum(["video", "side", "fullscreen", "off"]).optional(),
  singleKeyShortcuts: z.boolean().optional(),
  allowDuplicate: z.boolean().optional(),
  partyEnabled: z.boolean().optional(),
  guestRateLimitPerMinute: z.number().int().min(2).max(30).optional(),
  lrclibEnabled: z.boolean().optional()
}).strict();

export const partyJoinSchema = z.object({
  pin: z.string().regex(/^\d{6}$/).optional(),
  joinToken: z.string().min(32).max(200).optional(),
  displayName: z.string().trim().min(2).max(20)
}).strict().refine(
  (input) => Boolean(input.pin) !== Boolean(input.joinToken),
  { message: "Provide either pin or joinToken", path: ["pin"] }
);

export const secretPatchSchema = z.object({
  youtubeApiKey: z.string().trim().max(300)
}).strict();

const stateV2Schema = z.object({
  schemaVersion: z.literal(2),
  revision: z.number().int().nonnegative(),
  settings: z.object({
    stationName: z.string(),
    language: z.enum(["th", "en"]),
    theme: z.enum(["dark", "high-contrast"]),
    autoplayNext: z.boolean(),
    confirmPlayNow: z.boolean(),
    defaultVolume: z.number().int(),
    defaultLyricsMode: z.enum(["video", "side", "fullscreen", "off"]),
    singleKeyShortcuts: z.boolean(),
    allowDuplicate: z.boolean(),
    partyEnabled: z.boolean(),
    guestRateLimitPerMinute: z.number().int(),
    lrclibEnabled: z.boolean()
  }),
  current: z.any().nullable(),
  queue: z.array(z.any()).max(100),
  favorites: z.array(z.any()).max(1_000),
  history: z.array(z.any()).max(1_000),
  lyrics: z.array(z.any()).max(1_000)
});

function migrateTrack(track) {
  if (!track || typeof track !== "object" || Array.isArray(track)) return track;
  return {
    ...track,
    classification: track.classification ?? null,
    badge: track.badge ?? null
  };
}

export const storedStateSchema = z.preprocess((input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  if (input.schemaVersion !== 1) return input;
  return {
    ...input,
    schemaVersion: 2,
    current: input.current ? migrateTrack(input.current) : null,
    queue: Array.isArray(input.queue) ? input.queue.map(migrateTrack) : input.queue,
    favorites: Array.isArray(input.favorites) ? input.favorites.map(migrateTrack) : input.favorites,
    history: Array.isArray(input.history) ? input.history.map(migrateTrack) : input.history
  };
}, stateV2Schema);

export const storedSecretsSchema = z.object({
  youtubeApiKey: z.string(),
  partyPin: z.string().regex(/^\d{6}$/),
  partyPinExpiresAt: z.string().datetime()
});

export function defaultState() {
  return {
    schemaVersion: 2,
    revision: 0,
    settings: {
      stationName: "KaraokeStation",
      language: "th",
      theme: "dark",
      autoplayNext: true,
      confirmPlayNow: true,
      defaultVolume: 75,
      defaultLyricsMode: "video",
      singleKeyShortcuts: true,
      allowDuplicate: true,
      partyEnabled: false,
      guestRateLimitPerMinute: 10,
      lrclibEnabled: false
    },
    current: null,
    queue: [],
    favorites: [],
    history: [],
    lyrics: []
  };
}

export function generatePartyPin() {
  return String(randomInt(100_000, 1_000_000));
}

export function defaultSecrets(apiKey = "") {
  return {
    youtubeApiKey: apiKey,
    partyPin: generatePartyPin(),
    partyPinExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1_000).toISOString()
  };
}
