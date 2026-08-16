import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"

const [databasePath, sessionID, ownerID, gatePath] = process.argv.slice(2)
if (!databasePath || !sessionID || !ownerID || !gatePath) {
  throw new Error("Usage: session-lease-worker <database> <session> <owner> <gate>")
}

while (!existsSync(gatePath)) await Bun.sleep(5)

const database = new Database(databasePath)
database.exec("PRAGMA busy_timeout = 5000")
const now = Date.now()
const row = database
  .query(
    `UPDATE session_v2
        SET time_suspended = coalesce(time_suspended, ?),
            resume_attempts = CASE WHEN time_suspended IS NULL THEN 0 ELSE resume_attempts END,
            claim_owner = ?,
            claim_pid = ?,
            claim_hostname = ?,
            claim_updated_at = ?,
            claim_expires_at = ?
      WHERE id = ?
        AND (claim_owner IS NULL OR claim_owner = ? OR claim_expires_at <= ?)
      RETURNING id`,
  )
  .get(now, ownerID, process.pid, "worker", now, now + 60_000, sessionID, ownerID, now)

database.close(false)
console.log(JSON.stringify({ ownerID, claimed: row !== null }))
