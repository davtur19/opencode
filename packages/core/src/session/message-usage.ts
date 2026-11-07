export * as SessionMessageUsage from "./message-usage.js"

import { Effect } from "effect"
import type { DatabaseMigration } from "../database/migration.js"

type Transaction = Parameters<DatabaseMigration.Migration["up"]>[0]

/**
 * Derived per-message usage index. `session_message.data` holds the full JSON
 * payload (~10 KB per message), so reading tokens, cost and model for a stats
 * range means reading gigabytes. This table keeps the same values as typed
 * columns and stays in step through triggers, which covers every write path
 * (projector, fork copy, import, v1 migration).
 *
 * Additive on purpose: upstream ignores the table, and the triggers keep
 * filling it even when an upstream binary writes the database.
 */
export const table = "session_message_usage"

export function up(tx: Transaction) {
  return Effect.gen(function* () {
    yield* tx.run(`
      CREATE TABLE IF NOT EXISTS session_message_usage (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        variant TEXT,
        input INTEGER,
        output INTEGER,
        reasoning INTEGER,
        cache_read INTEGER,
        cache_write INTEGER,
        cost REAL
      )
    `)
    yield* tx.run(`
      CREATE INDEX IF NOT EXISTS session_message_usage_time_created_idx
      ON session_message_usage (time_created)
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_message_usage_insert
      AFTER INSERT ON session_message
      BEGIN
        INSERT OR REPLACE INTO session_message_usage (
          message_id, session_id, type, time_created, provider_id, model_id, variant,
          input, output, reasoning, cache_read, cache_write, cost
        ) VALUES (
          new.id, new.session_id, new.type, new.time_created,
          json_extract(new.data, '$.model.providerID'),
          json_extract(new.data, '$.model.id'),
          json_extract(new.data, '$.model.variant'),
          json_extract(new.data, '$.tokens.input'),
          json_extract(new.data, '$.tokens.output'),
          json_extract(new.data, '$.tokens.reasoning'),
          json_extract(new.data, '$.tokens.cache.read'),
          json_extract(new.data, '$.tokens.cache.write'),
          json_extract(new.data, '$.cost')
        );
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_message_usage_update
      AFTER UPDATE OF data, type, time_created, session_id ON session_message
      BEGIN
        INSERT OR REPLACE INTO session_message_usage (
          message_id, session_id, type, time_created, provider_id, model_id, variant,
          input, output, reasoning, cache_read, cache_write, cost
        ) VALUES (
          new.id, new.session_id, new.type, new.time_created,
          json_extract(new.data, '$.model.providerID'),
          json_extract(new.data, '$.model.id'),
          json_extract(new.data, '$.model.variant'),
          json_extract(new.data, '$.tokens.input'),
          json_extract(new.data, '$.tokens.output'),
          json_extract(new.data, '$.tokens.reasoning'),
          json_extract(new.data, '$.tokens.cache.read'),
          json_extract(new.data, '$.tokens.cache.write'),
          json_extract(new.data, '$.cost')
        );
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_message_usage_delete
      AFTER DELETE ON session_message
      BEGIN
        DELETE FROM session_message_usage WHERE message_id = old.id;
      END
    `)
  })
}

export function backfill(tx: Transaction) {
  return tx.run(`
    INSERT OR REPLACE INTO session_message_usage (
      message_id, session_id, type, time_created, provider_id, model_id, variant,
      input, output, reasoning, cache_read, cache_write, cost
    )
    SELECT
      id, session_id, type, time_created,
      json_extract(data, '$.model.providerID'),
      json_extract(data, '$.model.id'),
      json_extract(data, '$.model.variant'),
      json_extract(data, '$.tokens.input'),
      json_extract(data, '$.tokens.output'),
      json_extract(data, '$.tokens.reasoning'),
      json_extract(data, '$.tokens.cache.read'),
      json_extract(data, '$.tokens.cache.write'),
      json_extract(data, '$.cost')
    FROM session_message
  `)
}
