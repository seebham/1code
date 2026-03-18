/**
 * Handy tRPC router
 * Integrates with Handy (local offline speech-to-text) via CLI + history DB
 */

import { exec } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import Database from "better-sqlite3"
import { z } from "zod"
import { publicProcedure, router } from "../index"

const HANDY_DATA_DIR = path.join(
  os.homedir(),
  ".local/share/com.pais.handy"
)
const HANDY_HISTORY_DB = path.join(HANDY_DATA_DIR, "history.db")

// Common AppImage locations to check
const HANDY_APPIMAGE_PATHS = [
  path.join(os.homedir(), "AppImages/handy.appimage"),
  path.join(os.homedir(), "Applications/handy.appimage"),
  "/usr/local/bin/handy",
  "/usr/bin/handy",
]

function findHandyBinary(): string | null {
  for (const p of HANDY_APPIMAGE_PATHS) {
    if (fs.existsSync(p)) return p
  }
  return null
}

type TranscriptionRow = {
  id: number
  timestamp: number
  transcription_text: string
}

let handyDb: Database.Database | null = null

function getHandyDb(): Database.Database | null {
  if (handyDb) return handyDb
  if (!fs.existsSync(HANDY_HISTORY_DB)) return null
  try {
    handyDb = new Database(HANDY_HISTORY_DB, { readonly: true })
    return handyDb
  } catch {
    return null
  }
}

export const handyRouter = router({
  /**
   * Check if Handy is installed (binary + data dir exist)
   */
  isInstalled: publicProcedure.query(() => {
    const binary = findHandyBinary()
    const hasDataDir = fs.existsSync(HANDY_DATA_DIR)
    return {
      installed: !!binary && hasDataDir,
      binaryPath: binary,
    }
  }),

  /**
   * Toggle Handy transcription on/off via CLI
   * Sends --toggle-transcription to the running Handy instance
   */
  toggleTranscription: publicProcedure.mutation(async () => {
    const binary = findHandyBinary()
    if (!binary) {
      throw new Error("Handy is not installed")
    }

    return new Promise<{ success: boolean }>((resolve, reject) => {
      exec(`"${binary}" --toggle-transcription`, { timeout: 5000 }, (err) => {
        if (err) {
          reject(new Error("Failed to toggle Handy. Is it running?"))
          return
        }
        resolve({ success: true })
      })
    })
  }),

  /**
   * Get the latest transcription after a given timestamp
   * Used for polling after triggering transcription
   */
  getLatestAfter: publicProcedure
    .input(z.object({ afterTimestamp: z.number() }))
    .query(({ input }) => {
      const db = getHandyDb()
      if (!db) return { found: false as const, text: null, timestamp: null }

      try {
        const row = db
          .prepare(
            "SELECT id, timestamp, transcription_text FROM transcription_history WHERE timestamp > ? ORDER BY id DESC LIMIT 1"
          )
          .get(input.afterTimestamp) as TranscriptionRow | undefined

        if (!row) {
          return { found: false as const, text: null, timestamp: null }
        }

        return {
          found: true as const,
          text: row.transcription_text,
          timestamp: row.timestamp,
        }
      } catch {
        return { found: false as const, text: null, timestamp: null }
      }
    }),
})
