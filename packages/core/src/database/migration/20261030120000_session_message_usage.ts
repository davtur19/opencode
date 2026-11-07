import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"
import { SessionMessageUsage } from "../../session/message-usage.js"

const migration: DatabaseMigration.Migration = {
  id: "20261030120000_session_message_usage",
  up(tx) {
    return Effect.gen(function* () {
      yield* SessionMessageUsage.up(tx)
      yield* SessionMessageUsage.backfill(tx)
    })
  },
}

export default migration
