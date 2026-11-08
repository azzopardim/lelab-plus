import React, { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Hand, Square } from "lucide-react";
import VisualizerPanel from "@/components/control/VisualizerPanel";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useApi } from "@/contexts/ApiContext";
import { sendJogTarget } from "@/lib/jogApi";
import type { JogArm } from "@/lib/jogControls";

/**
 * 3D jog: drag a joint in the 3D view to move the real follower arm(s).
 * The session is started by the robot tile (/start-jog) before navigating
 * here; every way of leaving this page stops it, like Teleoperation does.
 */
const JogPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const bimanual = !!(location.state as { bimanual?: boolean } | null)?.bimanual;
  const { toast } = useToast();
  const { baseUrl, fetchWithHeaders } = useApi();

  const stoppedRef = useRef(false);
  const stopJog = useCallback(async () => {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    try {
      const res = await fetchWithHeaders(`${baseUrl}/stop-jog`, { method: "POST" });
      const data = await res.json();
      if (data?.success) {
        toast({ title: "3D jog stopped", description: "The arm was released." });
      }
    } catch {
      /* best-effort */
    }
  }, [baseUrl, fetchWithHeaders, toast]);

  useEffect(() => {
    const handlePageHide = () => {
      fetch(`${baseUrl}/stop-jog`, { method: "POST", keepalive: true }).catch(() => {});
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      stopJog();
    };
  }, [baseUrl, stopJog]);

  // One target request in flight at a time; a held drag re-sends every
  // 100 ms anyway, so a skipped refresh is caught by the next one.
  const inFlightRef = useRef(false);
  const errorShownRef = useRef(false);
  const reportFailure = useCallback(
    (message?: string) => {
      if (errorShownRef.current) return;
      errorShownRef.current = true;
      toast({
        title: "The arm isn't following",
        description: message || "3D jog stopped responding. Go back and start it again.",
        variant: "destructive",
      });
    },
    [toast]
  );

  const onJogHold = useCallback(
    (arm: JogArm, joints: Record<string, number>) => {
      if (stoppedRef.current || inFlightRef.current) return;
      inFlightRef.current = true;
      sendJogTarget(baseUrl, fetchWithHeaders, arm, joints)
        .then((res) => {
          if (!res.success) reportFailure(res.message);
        })
        .catch(() => reportFailure())
        .finally(() => {
          inFlightRef.current = false;
        });
    },
    [baseUrl, fetchWithHeaders, reportFailure]
  );

  const onJogRelease = useCallback(
    (arm: JogArm) => {
      if (stoppedRef.current) return;
      sendJogTarget(baseUrl, fetchWithHeaders, arm, null).catch(() => {});
    },
    [baseUrl, fetchWithHeaders]
  );

  const handleGoBack = async () => {
    await stopJog();
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-2 sm:p-4">
      <div className="w-full h-[95vh] flex">
        <VisualizerPanel
          onGoBack={handleGoBack}
          className="lg:w-full"
          title="3D jog"
          bimanual={bimanual}
          mode="jog"
          onJogHold={onJogHold}
          onJogRelease={onJogRelease}
          headerSlot={
            <Button
              onClick={handleGoBack}
              className="bg-red-600 hover:bg-red-700 text-white"
              aria-label="Stop and release the arm"
            >
              <Square className="w-4 h-4 mr-2 fill-current" />
              Stop
            </Button>
          }
          notice={
            <div className="flex items-start gap-2 rounded-md border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
              <Hand className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>
                Hold and drag a joint to move the real {bimanual ? "arm under it" : "arm"}. It
                follows slowly (up to 60°/s) and stops as soon as you let go. Stop releases
                the torque, so support the arm first.
              </span>
            </div>
          }
        />
      </div>
    </div>
  );
};

export default JogPage;
