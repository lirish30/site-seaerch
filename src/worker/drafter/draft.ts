import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { pickRecipient } from "../recipient";
import { domainOf } from "../db/businesses";
import { buildPrompt, type DraftInput } from "./prompt";

export { buildPrompt, type DraftInput };
export const DRAFT_MODEL = "claude-sonnet-5-5";
export type ClaudeCaller = (p: { system: string; user: string }) => Promise<unknown>;

const Output = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  to_contact_id: z.string().nullable(),
  recipient_reason: z.string(),
});

const TOOL = {
  name: "write_email",
  description: "Return the drafted outreach email.",
  input_schema: {
    type: "object" as const,
    properties: {
      subject: { type: "string" },
      body: { type: "string" },
      to_contact_id: { type: ["string", "null"] },
      recipient_reason: { type: "string" },
    },
    required: ["subject", "body", "to_contact_id", "recipient_reason"],
  },
};

export function anthropicCaller(apiKey: string): ClaudeCaller {
  const client = new Anthropic({ apiKey });
  return async ({ system, user }) => {
    const msg = await client.messages.create({
      model: DRAFT_MODEL, max_tokens: 800, system,
      tools: [TOOL], tool_choice: { type: "tool", name: TOOL.name },
      messages: [{ role: "user", content: user }],
    });
    const block = msg.content.find((b) => b.type === "tool_use");
    return block && "input" in block ? block.input : null;
  };
}

export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export async function generateDraft(i: DraftInput, call: ClaudeCaller) {
  const prompt = buildPrompt(i);
  let parsed: z.infer<typeof Output> | null = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const r = Output.safeParse(await call(prompt));
    if (r.success) parsed = r.data;
  }
  if (!parsed) throw new Error("Claude returned malformed draft output twice");

  const ranked = pickRecipient(i.contacts, domainOf(i.business.website_url));
  const emailIds = new Set(i.contacts.filter((c) => c.type === "email").map((c) => c.id));
  let toId = parsed.to_contact_id && emailIds.has(parsed.to_contact_id) ? parsed.to_contact_id : null;
  let reason = parsed.recipient_reason;
  if (!toId) { toId = ranked.emailContact?.id ?? null; reason = ranked.reason; }

  let body = parsed.body.trimEnd();
  for (const line of [i.settings.physical_address, i.settings.opt_out_line]) {
    if (line && !body.includes(line)) body += `\n${line}`;
  }
  return { subject: parsed.subject.trim(), body, to_contact_id: toId, recipient_reason: reason };
}
