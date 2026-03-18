import { AudioLines } from "lucide-react"
import { Button } from "../../../components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip"
import { cn } from "../../../lib/utils"

type HandyVoiceButtonProps = {
  isListening: boolean
  onClick: () => void
  disabled?: boolean
}

export const HandyVoiceButton = ({
  isListening,
  onClick,
  disabled,
}: HandyVoiceButtonProps) => {
  return (
    <Tooltip delayDuration={1000}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          className={cn(
            "h-7 w-7 rounded-sm outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70",
            isListening && "text-red-500 animate-pulse"
          )}
          onClick={onClick}
          disabled={disabled}
        >
          <AudioLines className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {isListening ? "Listening... (click to cancel)" : "Voice input (Handy)"}
      </TooltipContent>
    </Tooltip>
  )
}
