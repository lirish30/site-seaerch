export interface GoogleAuthRow { email: string | null; refresh_token_enc: string; folder_id: string | null; connected_at: string; scope: string | null; }

export const getGoogleAuth = (db: D1Database) => db.prepare(`SELECT * FROM google_auth WHERE id = 1`).first<GoogleAuthRow>();

export async function saveGoogleAuth(db: D1Database, email: string | null, refreshTokenEnc: string, scope: string | null) {
  await db.prepare(`INSERT INTO google_auth (id, email, refresh_token_enc, connected_at, scope) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET email = excluded.email, refresh_token_enc = excluded.refresh_token_enc, connected_at = excluded.connected_at, scope = excluded.scope`)
    .bind(email, refreshTokenEnc, new Date().toISOString(), scope).run();
}

export const setGoogleFolder = (db: D1Database, folderId: string) =>
  db.prepare(`UPDATE google_auth SET folder_id = ? WHERE id = 1`).bind(folderId).run();

export const deleteGoogleAuth = (db: D1Database) => db.prepare(`DELETE FROM google_auth WHERE id = 1`).run();
