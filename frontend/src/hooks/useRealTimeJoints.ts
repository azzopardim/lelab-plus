import { useEffect, useRef, useState, useCallback } from "react";
import { URDFViewerElement } from "@/lib/urdfViewerHelpers";
import { JointedRobot, setRobotJoints } from "@/lib/bimanualScene";
import { useApi } from "@/contexts/ApiContext";

interface JointData {
  type: "joint_update";
  joints: Record<string, number>;
  /** Present for a bimanual robot; `joints` then mirrors the left arm. */
  arms?: Partial<Record<"left" | "right", Record<string, number>>>;
  timestamp: number;
}

interface UseRealTimeJointsProps {
  viewerRef: React.RefObject<URDFViewerElement>;
  enabled?: boolean;
  websocketUrl?: string;
  /**
   * Bimanual robot: the viewer's own robot mirrors the left arm and
   * rightRobotRef (the copy placed beside it) the right arm.
   */
  bimanual?: boolean;
  rightRobotRef?: React.RefObject<JointedRobot | null>;
  /** Arm currently held in a jog drag; its live updates are skipped. */
  heldArmRef?: React.RefObject<"left" | "right" | null>;
}

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

export const useRealTimeJoints = ({
  viewerRef,
  enabled = true,
  websocketUrl,
  bimanual = false,
  rightRobotRef,
  heldArmRef,
}: UseRealTimeJointsProps) => {
  const { wsBaseUrl } = useApi();
  const finalWebSocketUrl = websocketUrl || `${wsBaseUrl}/ws/joint-data`;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);
  const intentionallyClosedRef = useRef(false);
  const [isConnected, setIsConnected] = useState(false);

  const updateJointValues = useCallback(
    (joints: Record<string, number>) => {
      const viewer = viewerRef.current;
      if (!viewer || typeof viewer.setJointValue !== "function") return;
      Object.entries(joints).forEach(([jointName, value]) => {
        try {
          viewer.setJointValue(jointName, value);
        } catch (error) {
          console.warn(`Failed to set joint ${jointName}:`, error);
        }
      });
    },
    [viewerRef]
  );

  useEffect(() => {
    if (!enabled) return;

    intentionallyClosedRef.current = false;

    const connect = () => {
      if (intentionallyClosedRef.current) return;

      let ws: WebSocket;
      try {
        ws = new WebSocket(finalWebSocketUrl);
      } catch (error) {
        console.error("Failed to create WebSocket:", error);
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as JointData;
          if (data.type === "joint_update" && data.joints) {
            // `joints` is the single arm, or the left arm of a bimanual robot.
            const held = heldArmRef?.current;
            if (held !== "left") updateJointValues(data.arms?.left ?? data.joints);
            const right = bimanual && held !== "right" ? data.arms?.right : undefined;
            const rightRobot = rightRobotRef?.current;
            if (right && rightRobot && setRobotJoints(rightRobot, right)) {
              viewerRef.current?.redraw();
            }
          }
        } catch (error) {
          console.error("Error parsing WebSocket message:", error);
        }
      };

      ws.onclose = (event) => {
        setIsConnected(false);
        wsRef.current = null;
        if (intentionallyClosedRef.current) return;
        if (event.code === 1000) return; // clean close
        scheduleReconnect();
      };

      ws.onerror = () => {
        setIsConnected(false);
      };
    };

    const scheduleReconnect = () => {
      if (reconnectTimeoutRef.current) return;
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(
        delay * 2,
        MAX_RECONNECT_DELAY_MS
      );
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;
        connect();
      }, delay);
    };

    connect();

    return () => {
      intentionallyClosedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close(1000);
        wsRef.current = null;
      }
      setIsConnected(false);
    };
  }, [enabled, finalWebSocketUrl, updateJointValues, bimanual, rightRobotRef, heldArmRef, viewerRef]);

  return { isConnected };
};
