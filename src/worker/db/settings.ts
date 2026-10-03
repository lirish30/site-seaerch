import type { Settings } from "../types";

const FIELDS: (keyof Settings)[] = [
  "your_name", "business_name", "contact_email", "services_blurb", "signature",
  "physical_address", "opt_out_line", "tone_notes", "monthly_spend_limit_usd",
];

export async function getSettings(db: D1Database): Promise<Settings> {
  return (await db.prepare(`SELECT * FROM settings WHERE id = 1`).first<Settings>())!;
}

export async function saveSettings(db: D1Database, s: Partial<Settings>): Promise<Settings> {
  const keys = FIELDS.filter((k) => s[k] !== undefined);
  if (keys.length) {
    await db.prepare(`UPDATE settings SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = 1`)
      .bind(...keys.map((k) => s[k])).run();
  }
  return getSettings(db);
}
