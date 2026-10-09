import { z } from "zod";

export const InputModeSchema = z.enum(["send", "steer", "queue"]);
export type InputMode = z.infer<typeof InputModeSchema>;

const EntryBase = { id: z.string(), turnId: z.string(), at: z.string().optional() };
const QuestionSchema = z.object({
  id: z.string().optional(),
  header: z.string().optional(),
  text: z.string(),
  multi: z.boolean(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  answers: z.array(z.string()).optional(),
});
export type Question = z.infer<typeof QuestionSchema>;
export const SessionEntrySchema = z.discriminatedUnion("kind", [
  z.object({ ...EntryBase, kind: z.literal("message"), role: z.enum(["user", "assistant"]), text: z.string() }),
  z.object({ ...EntryBase, kind: z.literal("activity"), title: z.string(), input: z.string(), output: z.string(), status: z.enum(["running", "complete", "failed"]), diff: z.string().optional() }),
  z.object({ ...EntryBase, kind: z.literal("status"), text: z.string() }),
  z.object({ ...EntryBase, kind: z.literal("question"), title: z.string(), questions: z.array(QuestionSchema), resolved: z.boolean(), answer: z.string().optional() }),
]);
export type SessionEntry = z.infer<typeof SessionEntrySchema>;
export const SessionCapabilitiesSchema = z.object({
  inputModes: z.array(InputModeSchema),
  stop: z.boolean(),
  fit: z.boolean(),
});
export type SessionCapabilities = z.infer<typeof SessionCapabilitiesSchema>;
// Context use of the latest parent model call. Optional on the wire: an older
// bridge omits it, and a value this client cannot read is dropped rather than
// failing the whole conversation, so the meter can only ever be absent.
const RateWindowSchema = z.object({
  usedPercent: z.number().min(0).max(100),
  windowMinutes: z.number().positive().optional(),
  resetsAt: z.number().positive().optional(),
});
export type RateWindow = z.infer<typeof RateWindowSchema>;
export const ContextUsageSchema = z.object({
  used: z.number().nonnegative(),
  capacity: z.number().positive().optional(),
  limits: z.object({ primary: RateWindowSchema.optional(), secondary: RateWindowSchema.optional() }).optional(),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;
export const SessionResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable"), agentId: z.string(), reason: z.string() }),
  z.object({
    kind: z.literal("available"), agentId: z.string(), sessionId: z.string(),
    entries: z.array(SessionEntrySchema), cursor: z.string(), before: z.string().nullable(), reset: z.boolean(),
    capabilities: SessionCapabilitiesSchema,
    context: ContextUsageSchema.optional().catch(undefined),
  }),
]);
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const SubmissionSchema = z.object({
  id: z.string().uuid(), target: z.string().min(1), sessionId: z.string().min(1),
  mode: z.enum(["send", "steer", "queue", "terminal", "stop"]),
  text: z.string().max(32768),
  attachment: z.object({ name: z.string(), type: z.string(), data: z.string() }).optional(),
});
export type Submission = z.infer<typeof SubmissionSchema>;
export const ReceiptSchema = z.object({
  id: z.string(), state: z.enum(["delivered", "queued", "failed", "unknown"]), message: z.string(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;
