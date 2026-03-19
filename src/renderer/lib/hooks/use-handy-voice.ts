import { useCallback, useRef, useState } from "react"
import { toast } from "sonner"
import { trpc } from "../trpc"

const POLL_INTERVAL_MS = 500
// After stopping Handy, wait up to 10s for the transcription to appear in DB
const STOP_WAIT_MS = 30_000

export function useHandyVoice() {
  const [isListening, setIsListening] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startTimestampRef = useRef<number>(0)
  const onResultRef = useRef<((text: string) => void) | null>(null)

  const { data: handyStatus } = trpc.handy.isInstalled.useQuery()
  const toggleMutation = trpc.handy.toggleTranscription.useMutation()
  const trpcUtils = trpc.useUtils()

  const cleanup = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    setIsListening(false)
  }, [])

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current)

    pollRef.current = setInterval(async () => {
      try {
        const result = await trpcUtils.handy.getLatestAfter.fetch({
          afterTimestamp: startTimestampRef.current,
        })
        if (result.found && result.text) {
          cleanup()
          onResultRef.current?.(result.text)
        }
      } catch {
        // Silently retry on poll errors
      }
    }, POLL_INTERVAL_MS)
  }, [trpcUtils, cleanup])

  const startListening = useCallback(
    async (onResult: (text: string) => void) => {
      if (isListening) return

      try {
        await toggleMutation.mutateAsync()
      } catch {
        toast.error("Failed to start Handy. Is it running?")
        return
      }

      // Record start timestamp (Handy uses Unix seconds)
      startTimestampRef.current = Math.floor(Date.now() / 1000) - 1
      onResultRef.current = onResult
      setIsListening(true)

      startPolling()
    },
    [isListening, toggleMutation, startPolling]
  )

  const stopListening = useCallback(async () => {
    if (!isListening) return

    // Toggle Handy off (stop recording) — this triggers Handy to transcribe and write to DB
    try {
      await toggleMutation.mutateAsync()
    } catch {
      // Ignore toggle-off errors
    }

    // Give Handy time to transcribe and write to DB
    timeoutRef.current = setTimeout(() => {
      cleanup()
      toast.info("No transcription received from Handy")
    }, STOP_WAIT_MS)

    // Polling continues — it will pick up the result when Handy writes it
  }, [isListening, toggleMutation, cleanup])

  return {
    isInstalled: handyStatus?.installed ?? false,
    isListening,
    startListening,
    stopListening,
  }
}
