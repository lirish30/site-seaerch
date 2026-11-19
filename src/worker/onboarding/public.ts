import { logActivityOnce } from "../db/activity";
import { getBusiness } from "../db/businesses";
import { getDocument } from "../db/documents";
import {
  getAnswers, getOnboardingByToken, listFiles, listItems, saveAnswers, saveItemText, submitQuestionnaire, touchClient,
  type ItemKind, type ItemStatus, type Onboarding, type OnboardingItem,
} from "../db/onboardings";
import { getSettings } from "../db/settings";
import { parseConfig } from "../booking/config";
import type { Env } from "../env";
import { isClientToken } from "../documents/token";
import { silentDays, stageOf, type Stage } from "./schedule";
import { cleanText, looksLikeCredential, questionsFor, validateAnswers, type Question } from "./templates";

/** The client's onboarding page and what the client can write to it. Everything typed here is untrusted: cleaned on the way in, never repeated in an error. */

export interface PublicOnboardingItem {
  id: string; key: string; label: string; instructions: string; kind: ItemKind; phase: 1 | 2; dueAt: string | null; status: ItemStatus; textValue: string | null;
  files: { id: string; fileName: string; sizeBytes: number }[];
}
export interface PublicOnboarding {
  businessName: string; contactFirstName: string; stage: Stage; kickoffAt: string | null; welcomeVideoUrl: string | null;
  questionnaire: { questions: Question[]; answers: Record<string, string>; dueAt: string | null; submittedAt: string | null };
  items: PublicOnboardingItem[];
  /** The questionnaire counts as one step and each checklist item as one; an item that is no longer waiting is done. */
  progress: { done: number; total: number };
  closed: boolean;
  /** The owner's IANA zone, for showing due dates and the kickoff. */
  timezone: string;
}

/** What a write answers with. `fields` are question ids (or an item id): never what the client typed. `error` is fixed text. */
export type WriteResult = { ok: true; already?: boolean } | { ok: false; status: 400 | 404 | 409 | 422; error?: string; fields?: string[] };

/** The most text one checklist item takes. */
export const ITEM_TEXT_MAX = 5000;
const NAME_MAX = 60;
const LABEL_MAX = 100;

const notFound: WriteResult = { ok: false, status: 404 };
const closedResult: WriteResult = { ok: false, status: 409, error: "this onboarding is closed" };
const lockedResult: WriteResult = { ok: false, status: 409, error: "the questionnaire was already submitted" };
const settledResult: WriteResult = { ok: false, status: 409, error: "this item is already settled" };
const bad = (fields?: string[]): WriteResult => ({ ok: false, status: 400, ...(fields?.length && { fields }) });

/** The onboarding behind a link, or null: not a token, unknown or revoked. A malformed token is never looked up. */
const find = (env: Env, token: string): Promise<Onboarding | null> => (isClientToken(token) ? getOnboardingByToken(env.DB, token) : Promise.resolve(null));

/** The question ids a problem list names ("id: what is wrong"), once each and in order. A problem that names no question gives nothing. */
const idsOf = (problems: string[]): string[] => [...new Set(problems.flatMap((p) => /^([a-z][a-z0-9_]*):/.exec(p)?.[1] ?? []))];

export async function onboardingPage(env: Env, token: string, now: Date): Promise<PublicOnboarding | null> {
  const o = await find(env, token);
  if (!o) return null;
  const [items, answers, doc, settings] = await Promise.all([listItems(env.DB, o.id), getAnswers(env.DB, o.id), getDocument(env.DB, o.documentId), getSettings(env.DB)]);
  const header = doc?.content.header;
  const businessName = cleanText(header?.clientName ?? (await getBusiness(env.DB, o.businessId))?.name ?? "", 120);
  const contactFirstName = cleanText(header?.contactName ?? "", NAME_MAX).split(/\s+/)[0] ?? "";
  const pageItems = await Promise.all(items.map(async (i): Promise<PublicOnboardingItem> => ({
    id: i.id, key: i.key, label: i.label, instructions: i.instructions, kind: i.kind, phase: i.phase, dueAt: i.dueAt, status: i.status, textValue: i.textValue,
    files: i.kind === "files" ? (await listFiles(env.DB, i.id)).map((f) => ({ id: f.id, fileName: f.fileName, sizeBytes: f.sizeBytes })) : [],
  })));
  const done = pageItems.filter((i) => i.status !== "waiting").length + (o.questionnaireSubmittedAt ? 1 : 0);
  return {
    businessName, contactFirstName, stage: stageOf(o, items, now), kickoffAt: o.kickoffAt, welcomeVideoUrl: o.welcomeVideoUrl,
    questionnaire: { questions: questionsFor(o.kind), answers, dueAt: o.questionnaireDueAt, submittedAt: o.questionnaireSubmittedAt },
    items: pageItems, progress: { done, total: pageItems.length + 1 }, closed: !!o.closedAt, timezone: parseConfig(settings.booking_config).timezone,
  };
}

const oneLine = (s: string, max: number) => cleanText(s, 4 * max).replace(/\s+/g, " ").trim().slice(0, max).trim();
const dayOf = (now: Date) => now.toISOString().slice(0, 10);

/** Whether this write ends a long silence: the stage, read before the write stamps the client's activity, is `waiting_on_client`. */
export const endsSilence = (o: Onboarding, items: OnboardingItem[], now: Date): boolean => stageOf(o, items, now) === "waiting_on_client";

/** Logs that the client came back, once per silence (the line names the silence's length and the day). `before` is the onboarding as it was before the write. Never throws. */
export async function logResumed(env: Env, before: Onboarding, now: Date): Promise<void> {
  try { await logActivityOnce(env.DB, before.businessId, "onboarding_resumed", `Client is back after ${silentDays(before, now)} days of silence (${dayOf(now)})`); }
  catch (e) { console.error("onboarding: could not log the return", e instanceof Error ? e.message : "unknown error"); }
}

/** Logs that the client sent something for an item: once per item per day, however many times they save. The line carries the item's label, which the owner wrote. Never throws. */
export async function logReceived(env: Env, o: Onboarding, item: OnboardingItem, now: Date): Promise<void> {
  try { await logActivityOnce(env.DB, o.businessId, "onboarding_received", `Client sent: ${oneLine(item.label, LABEL_MAX)} (${dayOf(now)})`); }
  catch (e) { console.error("onboarding: could not log what was received", e instanceof Error ? e.message : "unknown error"); }
}

/**
 * Saves a draft of the answers. Only the questions this form asks are kept (the rest are dropped), each cleaned; the text is refused, with nothing saved,
 * when an answer is too long or not one of the choices (400) or reads like a login (422), naming the question ids. Locked once the questionnaire is
 * submitted or the onboarding is closed (409). Stamps the client's activity, and logs a return after a long silence.
 */
export async function saveClientAnswers(env: Env, token: string, answers: Record<string, string>, now: Date): Promise<WriteResult> {
  const o = await find(env, token);
  if (!o) return notFound;
  if (o.closedAt) return closedResult;
  if (o.questionnaireSubmittedAt) return lockedResult;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return bad();

  const known = new Set(questionsFor(o.kind).map((q) => q.id));
  const mine = Object.entries(answers).filter(([id]) => known.has(id));
  // Nothing this form asks was sent: nothing is saved, and the client has not "written" (the silence clock is not reset).
  if (!mine.length) return { ok: true };
  const notText = mine.filter(([, v]) => typeof v !== "string").map(([id]) => id);
  if (notText.length) return bad(notText);
  const cleaned = Object.fromEntries(mine.map(([id, v]) => [id, cleanText(v, v.length)]));

  const credential = Object.entries(cleaned).filter(([, v]) => looksLikeCredential(v)).map(([id]) => id);
  if (credential.length) return { ok: false, status: 422, fields: credential };
  const { problems } = validateAnswers(o.kind, cleaned, { requireAll: false });
  if (problems.length) return bad(idsOf(problems));

  const items = await listItems(env.DB, o.id);
  const resuming = endsSilence(o, items, now);
  await saveAnswers(env.DB, o.id, cleaned, now.toISOString());
  if (resuming) await logResumed(env, o, now);
  return { ok: true };
}

/** Hands in the questionnaire: every required question must have an answer (400 naming the ids that do not). The second time is `already`, not an error, and writes nothing. */
export async function submitClientQuestionnaire(env: Env, token: string, now: Date): Promise<WriteResult> {
  const o = await find(env, token);
  if (!o) return notFound;
  if (o.closedAt) return closedResult;
  if (o.questionnaireSubmittedAt) return { ok: true, already: true };

  const { problems } = validateAnswers(o.kind, await getAnswers(env.DB, o.id), { requireAll: true });
  if (problems.length) return bad(idsOf(problems));

  const items = await listItems(env.DB, o.id);
  const resuming = endsSilence(o, items, now);
  // Two submits at once: the store is conditional, so only one is "submitted" and logs.
  if ((await submitQuestionnaire(env.DB, o.id, now.toISOString())) === "already") return { ok: true, already: true };
  try { await logActivityOnce(env.DB, o.businessId, "onboarding_submitted", "Client submitted the questionnaire"); }
  catch (e) { console.error("onboarding: could not log the submission", e instanceof Error ? e.message : "unknown error"); }
  if (resuming) await logResumed(env, o, now);
  return { ok: true };
}

/**
 * Saves the text for a checklist item. The item must belong to this onboarding (404 otherwise, as for an unknown one) and take text (400 for a files item). An item the owner already accepted or marked not needed is settled: 409.
 * More than 5000 characters is refused (400), and text that reads like a login is a 422 naming the item: nothing typed is ever repeated back. An empty text
 * clears the item. Stamps the client's activity, logs what came in once per item per day, and logs a return after a long silence.
 */
export async function saveClientItemText(env: Env, token: string, itemId: string, text: string, now: Date): Promise<WriteResult> {
  const o = await find(env, token);
  if (!o) return notFound;
  if (o.closedAt) return closedResult;
  const items = await listItems(env.DB, o.id);
  const item = items.find((i) => i.id === itemId);
  if (!item) return notFound;
  if (item.kind !== "text" || typeof text !== "string") return bad();
  // Accepted and not-needed items are settled (as for uploads): the owner reopens one with "Ask again".
  if (item.status === "accepted" || item.status === "not_applicable") return settledResult;

  const cleaned = cleanText(text, text.length);
  if (cleaned.length > ITEM_TEXT_MAX) return bad([item.id]);
  if (looksLikeCredential(cleaned)) return { ok: false, status: 422, fields: [item.id] };

  const resuming = endsSilence(o, items, now);
  await saveItemText(env.DB, item.id, cleaned, now.toISOString());
  await touchClient(env.DB, o.id, now.toISOString());
  if (cleaned) await logReceived(env, o, item, now);
  if (resuming) await logResumed(env, o, now);
  return { ok: true };
}
