import { z } from "zod";

/** The summary of one meeting, as the AI writes it and as it is stored. The limits keep the stored JSON and the follow-up email a sane size. */
export const MeetingSummarySchema = z.object({
  summary: z.string().max(1500),
  decisions: z.array(z.string().max(300)).max(10),
  actionItems: z.array(z.object({
    title: z.string().max(160),
    owner: z.enum(["logan", "client"]),
    dueOn: z.string().nullable(),
  })).max(15),
  possibleChangeOrders: z.array(z.object({
    title: z.string(),
    summary: z.string(),
    reason: z.string(),
    hours: z.number(),
  })).max(3),
  followUp: z.object({ subject: z.string().max(120), body: z.string().max(2500) }),
  generatedAt: z.string(),
});

export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;
