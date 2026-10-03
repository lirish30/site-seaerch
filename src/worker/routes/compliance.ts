import { getSettings } from "../db/settings";

export const MISSING_MAILING_SETTINGS = "Fill in your physical address and opt-out line in Settings first";

/** CAN-SPAM: every draft needs a physical address and an opt-out line, so refuse work that drafts until both exist. */
export async function mailingSettingsMissing(db: D1Database): Promise<boolean> {
  const s = await getSettings(db);
  return !s.physical_address?.trim() || !s.opt_out_line?.trim();
}
