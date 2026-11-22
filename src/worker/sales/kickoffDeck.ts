import type { OwnerTag, TaskStatus } from "../sop/model";
import type { DeckBlock, DeckSlide } from "./deck";

/** A build step as the kickoff deck needs it. `owner` is who on our side does it; the data has no "client" owner, so a need from the client is a step waiting on them. */
export interface KickoffStep { phaseKey: string; phaseTitle: string; title: string; owner: OwnerTag; clientSummary: string | null; status: TaskStatus }

export interface KickoffInput { clientName: string; yourName: string; steps: KickoffStep[] }

const text = (t: string, style?: Extract<DeckBlock, { type: "text" }>["style"]): DeckBlock => (style ? { type: "text", text: t, style } : { type: "text", text: t });
const sentenceOf = (s: KickoffStep): string | null => s.clientSummary?.trim() || null;

/**
 * The deck Logan walks a new build client through: a welcome, how the work goes (the phases in order), then one slide per phase with what we do and what we need from you.
 * It is made only of the steps given and says nothing of dates. A step shows only its `clientSummary` (a step without one shows nothing, so nothing is invented); a step that
 * is waiting on the client and has a summary is a "need from you"; every other step with a summary is something we do. Skipped steps and phases left with no steps are left out.
 */
export function buildKickoffDeck(i: KickoffInput): DeckSlide[] {
  const phases: { key: string; title: string; steps: KickoffStep[] }[] = [];
  for (const s of i.steps) {
    if (s.status === "skipped") continue;
    let p = phases.find((x) => x.key === s.phaseKey);
    if (!p) { p = { key: s.phaseKey, title: s.phaseTitle, steps: [] }; phases.push(p); }
    p.steps.push(s);
  }
  const you = i.yourName.trim();
  const parts = phases.map((p) => ({
    p,
    ours: p.steps.filter((s) => s.status !== "waiting_client").flatMap((s) => sentenceOf(s) ?? []),
    theirs: p.steps.filter((s) => s.status === "waiting_client").flatMap((s) => sentenceOf(s) ?? []),
  }));
  // Only promise what the deck shows: most decks have no step waiting on the client.
  const anyNeeds = parts.some((x) => x.theirs.length > 0);
  const slides: DeckSlide[] = [
    {
      key: "title", title: i.clientName,
      blocks: [text("Project kickoff", "eyebrow"), text(`Here is how we will build your website together${you ? `  ·  ${you}` : ""}`, "lead")],
      speakerNote: "Welcome them, say what the call is for, and ask what they most want to get out of the project.",
    },
    {
      key: "agenda", title: "How we will work",
      blocks: [
        text("Kickoff", "eyebrow"),
        { type: "list", numbered: true, items: phases.map((p) => ({ text: p.title })) },
        text(anyNeeds ? "In each part you will see what we do and what we need from you." : "In each part you will see what we do.", "fine"),
      ],
      speakerNote: "Walk the parts in order. Say that we will tell them before anything needs them, and that they can ask about any part at any time.",
    },
  ];
  for (const { p, ours, theirs } of parts) {
    const blocks: DeckBlock[] = [];
    if (ours.length) blocks.push({ type: "list", heading: "What we do", items: ours.map((t) => ({ text: t })) });
    if (theirs.length) blocks.push({ type: "list", heading: "What we need from you", items: theirs.map((t) => ({ text: t })) });
    if (!blocks.length) blocks.push(text("We will walk you through this part when we get to it.", "lead"));
    slides.push({
      key: "timeline", title: p.title, blocks,
      speakerNote: `Cover ${p.title}: what we do, then what we need from them. Ask whether anything here is unclear.`,
    });
  }
  return slides;
}
