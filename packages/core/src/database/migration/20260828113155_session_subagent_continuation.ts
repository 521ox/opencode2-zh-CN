import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260828113155_session_subagent_continuation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_subagent_continuation\` (
          \`id\` text PRIMARY KEY,
          \`parent_session_id\` text NOT NULL,
          \`parent_message_id\` text NOT NULL,
          \`parent_tool_call_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`description\` text NOT NULL,
          \`inbox_id\` text NOT NULL,
          \`turn_id\` text,
          \`state\` text NOT NULL,
          \`prompt_digest\` text NOT NULL,
          \`time_terminal\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_subagent_continuation_parent_session_id_session_v2_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_subagent_continuation_child_session_id_session_v2_id_fk\` FOREIGN KEY (\`child_session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_subagent_continuation_turn_id_session_subagent_turn_id_fk\` FOREIGN KEY (\`turn_id\`) REFERENCES \`session_subagent_turn\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_subagent_turn\` (
          \`id\` text PRIMARY KEY,
          \`child_session_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`assistant_message_id\` text,
          \`output\` text,
          \`error\` text,
          \`time_terminal\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_subagent_turn_child_session_id_session_v2_id_fk\` FOREIGN KEY (\`child_session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_subagent_continuation_parent_call_idx\` ON \`session_subagent_continuation\` (\`parent_session_id\`,\`parent_message_id\`,\`parent_tool_call_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_subagent_continuation_inbox_idx\` ON \`session_subagent_continuation\` (\`inbox_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_subagent_continuation_child_state_idx\` ON \`session_subagent_continuation\` (\`child_session_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_subagent_continuation_turn_state_idx\` ON \`session_subagent_continuation\` (\`turn_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_subagent_turn_child_active_idx\` ON \`session_subagent_turn\` (\`child_session_id\`) WHERE "session_subagent_turn"."state" = 'active';`,
      )
    })
  },
}

export default migration
