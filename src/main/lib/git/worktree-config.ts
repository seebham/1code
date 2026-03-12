import { readFile, writeFile, mkdir, access } from "node:fs/promises"
import { join, dirname, isAbsolute } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { getShellEnvironment } from "./shell-env"

const execFileAsync = promisify(execFile)
const SETUP_COMMAND_TIMEOUT_MS = 900_000 // 15 minutes (pnpm install can be slow in large repos)
const WORKTREE_SETUP_EXEC_VERSION = "esfc-shell-v1"

async function collectShellDiagnostics(
  shell: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const lines: string[] = []
  lines.push(`[diag] executor=${WORKTREE_SETUP_EXEC_VERSION}`)
  lines.push(`[diag] shell=${shell}`)
  lines.push(`[diag] cwd=${cwd}`)
  lines.push(`[diag] env.SHELL=${env.SHELL || "<unset>"}`)
  lines.push(`[diag] env.PATH=${env.PATH || "<unset>"}`)

  try {
    const { stdout } = await execFileAsync(shell, [
      "-lc",
      "command -v pnpm || echo __PNPM_NOT_FOUND__",
    ], { cwd, env, timeout: 10_000 })
    lines.push(`[diag] pnpm=${stdout.trim() || "<empty>"}`)
  } catch (error) {
    lines.push(`[diag] pnpm-check-failed=${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const { stdout } = await execFileAsync(shell, [
      "-lc",
      "command -v corepack || echo __COREPACK_NOT_FOUND__",
    ], { cwd, env, timeout: 10_000 })
    lines.push(`[diag] corepack=${stdout.trim() || "<empty>"}`)
  } catch (error) {
    lines.push(`[diag] corepack-check-failed=${error instanceof Error ? error.message : String(error)}`)
  }

  return lines
}

function formatSetupCommandError(error: unknown, cmd: string): string {
  const lines: string[] = [`Command failed: ${cmd}`]

  if (error instanceof Error) {
    const errorWithMeta = error as Error & {
      stderr?: string
      stdout?: string
      code?: number | string
      signal?: NodeJS.Signals
      killed?: boolean
      cmd?: string
    }

    if (typeof errorWithMeta.code !== "undefined") {
      lines.push(`exit code: ${String(errorWithMeta.code)}`)
    }
    if (errorWithMeta.signal) {
      lines.push(`signal: ${errorWithMeta.signal}`)
    }
    if (errorWithMeta.killed) {
      lines.push("process killed: true (likely timeout)")
    }

    const normalizedMessage = error.message.trim()
    const genericMessage = `Command failed: ${cmd}`
    if (normalizedMessage && normalizedMessage !== genericMessage) {
      lines.push(error.message)
    }

    if (typeof errorWithMeta.stderr === "string" && errorWithMeta.stderr.trim()) {
      lines.push(`stderr:\n${errorWithMeta.stderr.trim()}`)
    }
    if (typeof errorWithMeta.stdout === "string" && errorWithMeta.stdout.trim()) {
      lines.push(`stdout:\n${errorWithMeta.stdout.trim()}`)
    }
  } else {
    lines.push(String(error))
  }

  return lines.join("\n\n")
}

export interface WorktreeConfig {
  "setup-worktree-unix"?: string[] | string
  "setup-worktree-windows"?: string[] | string
  "setup-worktree"?: string[] | string
}

export type WorktreeConfigSource = "custom" | "cursor" | "1code" | null

export interface DetectedWorktreeConfig {
  config: WorktreeConfig | null
  path: string | null
  source: WorktreeConfigSource
}

const CURSOR_CONFIG_PATH = ".cursor/worktrees.json"
const ONECODE_CONFIG_PATH = ".1code/worktree.json"

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf-8")
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

/**
 * Detect worktree config for a project
 * Priority: custom path > .cursor/worktrees.json > .1code/worktree.json
 */
export async function detectWorktreeConfig(
  projectPath: string,
  customPath?: string,
): Promise<DetectedWorktreeConfig> {
  // 1. Check custom path if provided
  if (customPath) {
    const fullPath = isAbsolute(customPath)
      ? customPath
      : join(projectPath, customPath)
    const config = await readJsonFile<WorktreeConfig>(fullPath)
    if (config) {
      return { config, path: fullPath, source: "custom" }
    }
  }

  // 2. Check .cursor/worktrees.json
  const cursorPath = join(projectPath, CURSOR_CONFIG_PATH)
  if (await fileExists(cursorPath)) {
    const config = await readJsonFile<WorktreeConfig>(cursorPath)
    if (config) {
      return { config, path: cursorPath, source: "cursor" }
    }
  }

  // 3. Check .1code/worktree.json
  const onecodePath = join(projectPath, ONECODE_CONFIG_PATH)
  if (await fileExists(onecodePath)) {
    const config = await readJsonFile<WorktreeConfig>(onecodePath)
    if (config) {
      return { config, path: onecodePath, source: "1code" }
    }
  }

  return { config: null, path: null, source: null }
}

/**
 * Get available config paths for a project
 * Returns which paths exist and can be used
 */
export async function getAvailableConfigPaths(
  projectPath: string,
): Promise<{
  cursor: { exists: boolean; path: string }
  onecode: { exists: boolean; path: string }
}> {
  const cursorPath = join(projectPath, CURSOR_CONFIG_PATH)
  const onecodePath = join(projectPath, ONECODE_CONFIG_PATH)

  return {
    cursor: {
      exists: await fileExists(cursorPath),
      path: cursorPath,
    },
    onecode: {
      exists: await fileExists(onecodePath),
      path: onecodePath,
    },
  }
}

/**
 * Save worktree config to a file
 * Creates parent directories if needed
 */
export async function saveWorktreeConfig(
  projectPath: string,
  config: WorktreeConfig,
  target: "cursor" | "1code" | string = "1code",
): Promise<{ success: boolean; path: string; error?: string }> {
  let targetPath: string

  if (target === "cursor") {
    targetPath = join(projectPath, CURSOR_CONFIG_PATH)
  } else if (target === "1code") {
    targetPath = join(projectPath, ONECODE_CONFIG_PATH)
  } else {
    // Custom path
    targetPath = isAbsolute(target) ? target : join(projectPath, target)
  }

  try {
    // Create parent directory
    await mkdir(dirname(targetPath), { recursive: true })

    // Write config
    const content = JSON.stringify(config, null, 2)
    await writeFile(targetPath, content, "utf-8")

    return { success: true, path: targetPath }
  } catch (error) {
    return {
      success: false,
      path: targetPath,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Get setup commands for current platform
 */
export function getSetupCommands(config: WorktreeConfig): string[] | string | null {
  // Generic setup-worktree takes priority (cross-platform)
  if (config["setup-worktree"]) {
    return config["setup-worktree"]
  }

  // Fall back to platform-specific commands
  if (process.platform === "win32") {
    return config["setup-worktree-windows"] ?? null
  }

  // Unix (darwin, linux)
  return config["setup-worktree-unix"] ?? null
}

export interface WorktreeSetupResult {
  success: boolean
  commandsRun: number
  output: string[]
  errors: string[]
}

export type WorktreeSetupProgressPhase =
  | "started"
  | "command-started"
  | "command-completed"
  | "completed"

export interface WorktreeSetupProgress {
  phase: WorktreeSetupProgressPhase
  totalCommands: number
  completedCommands: number
  commandIndex?: number
  currentCommand?: string
  success?: boolean
  error?: string
}

/**
 * Execute worktree setup commands
 * Runs after worktree creation to install deps, copy envs, etc.
 */
export async function executeWorktreeSetup(
  worktreePath: string,
  mainRepoPath: string,
  options?: {
    onProgress?: (progress: WorktreeSetupProgress) => void
  },
): Promise<WorktreeSetupResult> {
  const result: WorktreeSetupResult = {
    success: true,
    commandsRun: 0,
    output: [],
    errors: [],
  }

  // Detect config from main repo
  const detected = await detectWorktreeConfig(mainRepoPath)
  if (!detected.config) {
    result.output.push("No worktree config found, skipping setup")
    return result
  }

  // Get commands for current platform
  const commands = getSetupCommands(detected.config)
  if (!commands) {
    result.output.push("No commands for current platform")
    return result
  }

  // Normalize to array
  const commandList = Array.isArray(commands) ? commands : [commands]
  const runnableCommands = commandList.filter((command) => command.trim().length > 0)
  if (runnableCommands.length === 0) {
    result.output.push("Empty command list")
    return result
  }

  console.log(`[worktree-setup] Running ${runnableCommands.length} setup commands in ${worktreePath}`)
  options?.onProgress?.({
    phase: "started",
    totalCommands: runnableCommands.length,
    completedCommands: 0,
  })

  const shellEnv = await getShellEnvironment()
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash")
  const commandEnv = {
    ...process.env,
    ...shellEnv,
    ROOT_WORKTREE_PATH: mainRepoPath,
  }
  const setupDiagnostics = await collectShellDiagnostics(shell, worktreePath, commandEnv)
  for (const line of setupDiagnostics) {
    console.log(`[worktree-setup] ${line}`)
    result.output.push(line)
  }

  // Execute each command
  for (const [index, cmd] of runnableCommands.entries()) {
    try {
      result.output.push(`$ ${cmd}`)
      options?.onProgress?.({
        phase: "command-started",
        totalCommands: runnableCommands.length,
        completedCommands: result.commandsRun,
        commandIndex: index + 1,
        currentCommand: cmd,
      })

      const { stdout, stderr } = await execFileAsync(shell, ["-lc", cmd], {
        cwd: worktreePath,
        env: commandEnv,
        timeout: SETUP_COMMAND_TIMEOUT_MS,
      })

      if (stdout) {
        result.output.push(stdout.trim())
      }
      if (stderr) {
        result.output.push(`[stderr] ${stderr.trim()}`)
      }

      result.commandsRun++
      options?.onProgress?.({
        phase: "command-completed",
        totalCommands: runnableCommands.length,
        completedCommands: result.commandsRun,
        commandIndex: index + 1,
        currentCommand: cmd,
        success: true,
      })
      console.log(`[worktree-setup] ✓ ${cmd}`)
    } catch (error) {
      let errorMsg = formatSetupCommandError(error, cmd)
      if (errorMsg.includes("pnpm: command not found")) {
        errorMsg = `${errorMsg}\n\n${setupDiagnostics.join("\n")}`
      }
      result.errors.push(errorMsg)
      result.output.push(`[error] ${errorMsg}`)
      options?.onProgress?.({
        phase: "command-completed",
        totalCommands: runnableCommands.length,
        completedCommands: result.commandsRun,
        commandIndex: index + 1,
        currentCommand: cmd,
        success: false,
        error: errorMsg,
      })
      console.error(`[worktree-setup] ✗ ${cmd}: ${errorMsg}`)
      // Continue with next command, don't fail entirely
    }
  }

  result.success = result.errors.length === 0
  options?.onProgress?.({
    phase: "completed",
    totalCommands: runnableCommands.length,
    completedCommands: result.commandsRun,
    success: result.success,
  })

  console.log(
    `[worktree-setup] Completed: ${result.commandsRun}/${runnableCommands.length} commands, ` +
    `${result.errors.length} errors`
  )

  return result
}
