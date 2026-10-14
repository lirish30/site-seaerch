import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { pickRecipient } from "../recipient";
import { domainOf } from "../db/businesses";
import { buildPrompt, VARIANT_COUNT, type DraftInput } from "./prompt";

export { buildPrompt, type DraftInput };
export const DRAFT_MODEL = "claude-haiku-5-5";
export type ClaudeCaller = (p: { system: string; user: string }) => Promise<unknown>;

const Variant = z.object({ angle: z.string().default(""), subject: z.string().min(1), body: z.string().min(1) });
// A reply that ignores the variants schema and returns one flat email is still one usable variant.
const asVariants = (raw: unknown) => {
  const r = raw as Record<string, unknown> | null;
  return r && typeof r === "object" && !("variants" in r) && "subject" in r && "body" in r
    ? { ...r, variants: [{ angle: "", subject: r.subject, body: r.body }] } : raw;
};
const Output = z.preprocess(asVariants, z.object({
  variants: z.array(Variant).min(1).max(VARIANT_COUNT),
  to_contact_id: z.string().nullable(),
  recipient_reason: z.string(),
}));

const TOOL = {
  name: "write_email",
  description: "Return the drafted outreach email variants.",
  input_schema: {
    type: "object" as const,
    properties: {
      variants: {
        type: "array",
        minItems: 1,
        maxItems: VARIANT_COUNT,
        items: {
          type: "object",
          properties: { angle: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
          required: ["angle", "subject", "body"],
        },
      },
      to_contact_id: { type: ["string", "null"] },
      recipient_reason: { type: "string" },
    },
    required: ["variants", "to_contact_id", "recipient_reason"],
  },
};

export function anthropicCaller(apiKey: string): ClaudeCaller {
  const client = new Anthropic({ apiKey });
  return async ({ system, user }) => {
    const msg = await client.messages.create({
      // A forced tool_choice would skip thinking, so ask for the tool in the prompt instead; a missing
      // tool_use block falls through to generateDraft's retry.
      // Haiku 5.5 thinks adaptively; leave room so thinking can't crowd out the tool call. Medium effort keeps the copy natural.
      model: DRAFT_MODEL, max_tokens: 5000, output_config: { effort: "medium" },
      system: `${system}\n\nRespond only by calling the ${TOOL.name} tool.`,
      tools: [TOOL], tool_choice: { type: "auto" },
      messages: [{ role: "user", content: user }],
    });
    const block = msg.content.find((b) => b.type === "tool_use");
    return block && "input" in block ? block.input : null;
  };
}

export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Removes a signature, address or opt-out line the model wrote anyway: they are added when the email is composed. */
function stripTrailing(body: string, lines: string[]): string {
  let out = body.trimEnd();
  for (let pass = 0; pass < 3; pass++) {
    for (const l of lines.map((x) => x?.trim()).filter(Boolean)) if (out.endsWith(l)) out = out.slice(0, -l.length).trimEnd();
  }
  return out;
}

/**
 * Writes the email as several differently-angled variants (one when revising a draft). `preferredContactId`
 * (the lead's chosen point of contact) wins over the model's and the ranking's pick. The body carries no signature
 * or mailing footer; those are added when the email is composed.
 */
export async function generateDraft(i: DraftInput, call: ClaudeCaller, preferredContactId: string | null = null) {
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
  if (preferredContactId && emailIds.has(preferredContactId)) { toId = preferredContactId; reason = "Your chosen point of contact"; }
  if (!toId) { toId = ranked.emailContact?.id ?? null; reason = ranked.reason; }

  const strip = [i.settings.opt_out_line, i.settings.physical_address, i.settings.signature];
  const variants = parsed.variants.slice(0, i.revise ? 1 : VARIANT_COUNT)
    .map((v) => ({ angle: v.angle.trim(), subject: v.subject.trim(), body: stripTrailing(v.body, strip) }));
  return { variants, to_contact_id: toId, recipient_reason: reason };
}
