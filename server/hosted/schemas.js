import { z } from "zod";

export const roomIdSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/, "Invalid room id");

export const tokenSchema = z.string().min(32).max(200).regex(/^[A-Za-z0-9_-]+$/, "Invalid token");

export const joinRequestSchema = z.object({
  joinToken: tokenSchema,
  displayName: z.string().trim().min(1).max(20)
}).strict();

export const revisionSchema = z.object({
  revision: z.number().int().nonnegative().optional()
}).strict();

export const playNowSchema = z.object({
  itemId: z.string().uuid(),
  revision: z.number().int().nonnegative()
}).strict();

export const playbackPatchSchema = z.object({
  playing: z.boolean(),
  volume: z.number().int().min(0).max(100),
  muted: z.boolean()
}).strict().partial().refine(
  (patch) => Object.keys(patch).length > 0,
  { message: "At least one playback field is required" }
);

export const socketHandshakeSchema = z.object({
  roomId: roomIdSchema,
  token: tokenSchema
});
