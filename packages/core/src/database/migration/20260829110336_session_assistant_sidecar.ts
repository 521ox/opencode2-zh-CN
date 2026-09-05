import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260829110336_session_assistant_sidecar",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_assistant_active\` (
          \`message_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`data\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_assistant_active_message_id_session_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_assistant_active_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_assistant_part\` (
          \`message_id\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`type_ordinal\` integer NOT NULL,
          \`tool_id\` text,
          \`data\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_assistant_part_pk\` PRIMARY KEY(\`message_id\`, \`position\`),
          CONSTRAINT \`fk_session_assistant_part_message_id_session_assistant_active_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_assistant_active\`(\`message_id\`) ON DELETE CASCADE,
          CONSTRAINT "session_assistant_part_position_check" CHECK("position" >= 0),
          CONSTRAINT "session_assistant_part_type_ordinal_check" CHECK("type_ordinal" >= 0),
          CONSTRAINT "session_assistant_part_type_check" CHECK("type" in ('text', 'reasoning', 'tool')),
          CONSTRAINT "session_assistant_part_tool_id_check" CHECK(("type" = 'tool' and "tool_id" is not null) or ("type" <> 'tool' and "tool_id" is null))
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_assistant_active_session_idx\` ON \`session_assistant_active\` (\`session_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_assistant_part_message_type_ordinal_idx\` ON \`session_assistant_part\` (\`message_id\`,\`type\`,\`type_ordinal\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_assistant_part_message_type_position_idx\` ON \`session_assistant_part\` (\`message_id\`,\`type\`,\`position\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_assistant_part_message_tool_position_idx\` ON \`session_assistant_part\` (\`message_id\`,\`tool_id\`,\`position\`) WHERE "session_assistant_part"."type" = 'tool';`,
      )
    })
  },
}

export default migration
