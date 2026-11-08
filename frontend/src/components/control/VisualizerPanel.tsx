import React from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import UrdfViewer from "../UrdfViewer";
import Logo from "@/components/Logo";
import type { JogArm } from "@/lib/jogControls";

interface VisualizerPanelProps {
  onGoBack: () => void;
  className?: string;
  /** Optional content rendered as a column beside the 3D viewer (e.g. a camera panel). */
  rightSlot?: React.ReactNode;
  /** Two leader/follower pairs: show both arms side by side in one scene. */
  bimanual?: boolean;
  title?: string;
  /** Extra controls at the right end of the header (e.g. a Stop button). */
  headerSlot?: React.ReactNode;
  /** Shown between the header and the 3D view. */
  notice?: React.ReactNode;
  /** "view" (default) is display only; "jog" lets a drag move the real arm. */
  mode?: "view" | "jog";
  onJogHold?: (arm: JogArm, joints: Record<string, number>) => void;
  onJogRelease?: (arm: JogArm) => void;
}

const VisualizerPanel: React.FC<VisualizerPanelProps> = ({
  onGoBack,
  className,
  rightSlot,
  bimanual = false,
  title = "Teleoperation",
  headerSlot,
  notice,
  mode = "view",
  onJogHold,
  onJogRelease,
}) => {
  return (
    <div
      className={cn(
        "w-full p-2 sm:p-4 space-y-4 lg:space-y-0 lg:space-x-4 flex flex-col lg:flex-row",
        className
      )}
    >
      <div className="bg-gray-900 rounded-lg p-4 flex-1 flex flex-col">
        <div className="flex items-center gap-4 mb-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={onGoBack}
            className="text-gray-400 hover:text-white hover:bg-gray-800 flex-shrink-0"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <Logo iconOnly={true} />
          <div className="w-px h-6 bg-gray-700" />
          <h2 className="text-xl font-medium text-gray-200">{title}</h2>
          {headerSlot && <div className="ml-auto flex items-center gap-2">{headerSlot}</div>}
        </div>
        {notice && <div className="mb-3">{notice}</div>}
        <div className="flex-1 bg-black rounded border border-gray-800 min-h-[50vh] lg:min-h-0">
          <UrdfViewer
            bimanual={bimanual}
            mode={mode}
            onJogHold={onJogHold}
            onJogRelease={onJogRelease}
          />
        </div>
      </div>
      {rightSlot && (
        <div className="lg:w-96 flex flex-col">{rightSlot}</div>
      )}
    </div>
  );
};

export default VisualizerPanel;
