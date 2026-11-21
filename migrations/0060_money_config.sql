-- Money settings: a JSON document (the freedom-number target in cents). Empty means the defaults.
ALTER TABLE settings ADD COLUMN money_config TEXT NOT NULL DEFAULT '{}';
