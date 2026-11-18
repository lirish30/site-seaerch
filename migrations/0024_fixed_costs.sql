CREATE TABLE fixed_costs (id TEXT PRIMARY KEY, name TEXT NOT NULL, monthly_usd REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
INSERT INTO fixed_costs VALUES
 ('cf-workers-paid','Cloudflare Workers Paid',5,1,datetime('now')),
 ('domains','Domains (sitelineweb.com, hellositeline.com)',2,1,datetime('now')),
 ('google-workspace','Google Workspace (2 seats, from first deposit)',14,0,datetime('now'));
UPDATE settings SET monthly_spend_limit_usd = 150 WHERE monthly_spend_limit_usd = 25;
