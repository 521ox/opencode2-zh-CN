import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260816053649_session_execution_lease",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`claim_owner\` text;`)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`claim_pid\` integer;`)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`claim_hostname\` text;`)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`claim_updated_at\` integer;`)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`claim_expires_at\` integer;`)
      yield* tx.run(
        `CREATE INDEX \`session_v2_claim_expires_idx\` ON \`session_v2\` (\`claim_expires_at\`) WHERE "session_v2"."claim_expires_at" is not null;`,
      )
    })
  },
}

export default migration
