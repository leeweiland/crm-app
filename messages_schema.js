// Postgres schema for the message store (messages_db.js). Applied by
// backchannel/messages_backfill.mjs in this order: TABLES before the bulk
// copy, INDEXES and DAILY_STATS after it (building indexes once over the
// loaded table is far faster than maintaining them row by row during it).

export const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  seq                 bigserial,
  id                  text PRIMARY KEY,
  contact_id          text,
  channel             text,
  direction           text,
  source_type         text,
  source_id           text,
  provider_message_id text,
  to_addr             text,
  from_addr           text,
  subject             text,
  body                text,
  body_preview        text,
  status              text,
  fail_reason         text,
  sent_at             text,
  created_at          text,
  status_history      jsonb   NOT NULL DEFAULT '[]',
  inbox_done          boolean NOT NULL DEFAULT false,
  extra               jsonb   NOT NULL DEFAULT '{}',
  open_count          integer NOT NULL DEFAULT 0,
  click_count         integer NOT NULL DEFAULT 0,
  day                 text,
  is_test             boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS message_daily_stats (
  day         text   NOT NULL,
  channel     text   NOT NULL,
  direction   text   NOT NULL,
  source_type text   NOT NULL,
  status      text   NOT NULL,
  n           bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, channel, direction, source_type, status)
);`;

export const INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS messages_contact_seq ON messages (contact_id, seq)",
  "CREATE INDEX IF NOT EXISTS messages_provider ON messages (provider_message_id) WHERE provider_message_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS messages_source ON messages (source_type, source_id, seq) WHERE source_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS messages_inbound_recent ON messages (created_at DESC) WHERE direction = 'inbound'",
  "CREATE INDEX IF NOT EXISTS messages_unmatched ON messages (channel) WHERE contact_id IS NULL",
];

// Per-day counts by current status, kept exact by triggers: every insert,
// delete, and change of status (or of the fields the bucket is keyed by)
// moves one count. Test contacts' messages (is_test) never count -- the
// same rule crm_daily_message_stats.json applied.
export const DAILY_STATS_SQL = `
CREATE OR REPLACE FUNCTION message_daily_stats_bump(d text, ch text, dir text, st text, s text, delta int) RETURNS void AS $$
BEGIN
  IF d IS NULL THEN RETURN; END IF;
  INSERT INTO message_daily_stats (day, channel, direction, source_type, status, n)
  VALUES (d, coalesce(ch, ''), coalesce(dir, ''), coalesce(st, ''), coalesce(s, ''), delta)
  ON CONFLICT (day, channel, direction, source_type, status) DO UPDATE SET n = message_daily_stats.n + delta;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION message_daily_stats_trg() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND NOT OLD.is_test THEN
    PERFORM message_daily_stats_bump(OLD.day, OLD.channel, OLD.direction, OLD.source_type, OLD.status, -1);
  END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') AND NOT NEW.is_test THEN
    PERFORM message_daily_stats_bump(NEW.day, NEW.channel, NEW.direction, NEW.source_type, NEW.status, 1);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_daily_stats_ins_del ON messages;
CREATE TRIGGER messages_daily_stats_ins_del AFTER INSERT OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION message_daily_stats_trg();
DROP TRIGGER IF EXISTS messages_daily_stats_upd ON messages;
CREATE TRIGGER messages_daily_stats_upd AFTER UPDATE ON messages
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.day IS DISTINCT FROM NEW.day
    OR OLD.channel IS DISTINCT FROM NEW.channel OR OLD.direction IS DISTINCT FROM NEW.direction
    OR OLD.source_type IS DISTINCT FROM NEW.source_type OR OLD.is_test IS DISTINCT FROM NEW.is_test)
  EXECUTE FUNCTION message_daily_stats_trg();`;

// Counts rebuilt from scratch over the whole table (after the bulk copy,
// before the triggers take over).
export const REBUILD_DAILY_STATS_SQL = `
TRUNCATE message_daily_stats;
INSERT INTO message_daily_stats (day, channel, direction, source_type, status, n)
SELECT day, coalesce(channel, ''), coalesce(direction, ''), coalesce(source_type, ''), coalesce(status, ''), count(*)
  FROM messages WHERE day IS NOT NULL AND NOT is_test
 GROUP BY 1, 2, 3, 4, 5;`;
