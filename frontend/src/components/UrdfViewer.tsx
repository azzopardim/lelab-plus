import React, {
  useEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
  memo,
} from "react";
import { cn } from "@/lib/utils";

import URDFManipulator from "urdf-loader/src/urdf-manipulator-element.js";
import { useUrdf } from "@/hooks/useUrdf";
import { useRealTimeJoints } from "@/hooks/useRealTimeJoints";
import {
  createUrdfViewer,
  fitGridToRobot,
  setupMeshLoader,
  setupJointHighlighting,
  setupModelLoading,
  URDFViewerElement,
} from "@/lib/urdfViewerHelpers";
import {
  BIMANUAL_SPACING_M,
  JointedRobot,
  addArmLabel,
  placeBimanualArms,
} from "@/lib/bimanualScene";
import { JogArm, JogViewer, installJogDragging, setPickable } from "@/lib/jogControls";

// Register the URDFManipulator as a custom element if it hasn't been already
if (typeof window !== "undefined" && !customElements.get("urdf-viewer")) {
  customElements.define("urdf-viewer", URDFManipulator);
}
import * as THREE from "three";

// Extend the interface for the URDF viewer element to include background property
interface UrdfViewerElement extends HTMLElement {
  background?: string;
  setJointValue?: (jointName: string, value: number) => void;
}

interface UrdfViewerProps {
  /** Show both arms of a bimanual robot side by side in one scene. */
  bimanual?: boolean;
  /**
   * "view": display only (teleoperation; the leaders own the followers).
   * "jog": dragging a joint reports the arm's target pose while held.
   */
  mode?: "view" | "jog";
  onJogHold?: (arm: JogArm, joints: Record<string, number>) => void;
  onJogRelease?: (arm: JogArm) => void;
}

const UrdfViewer: React.FC<UrdfViewerProps> = ({
  bimanual = false,
  mode = "view",
  onJogHold,
  onJogRelease,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [highlightedJoint, setHighlightedJoint] = useState<string | null>(null);
  const { registerUrdfProcessor, alternativeUrdfModels, isDefaultModel } =
    useUrdf();

  const cleanupAnimationRef = useRef<(() => void) | null>(null);
  const viewerRef = useRef<URDFViewerElement | null>(null);
  const hasInitializedRef = useRef<boolean>(false);
  // The right arm's copy in bimanual mode (the left arm is viewer.robot).
  const rightRobotRef = useRef<JointedRobot | null>(null);
  // The arm being dragged in jog mode: live updates skip it so the drag
  // isn't pulled back to the follower's position mid-gesture.
  const heldArmRef = useRef<JogArm | null>(null);
  // Latest callbacks, read from the drag handlers without re-creating the viewer.
  const jogHandlersRef = useRef({ onJogHold, onJogRelease });
  jogHandlersRef.current = { onJogHold, onJogRelease };

  // Real-time joint updates via WebSocket
  const { isConnected: isWebSocketConnected } = useRealTimeJoints({
    viewerRef,
    enabled: isDefaultModel, // Only enable WebSocket for default model
    bimanual,
    rightRobotRef,
    heldArmRef,
  });

  // Add state for custom URDF path
  const [customUrdfPath, setCustomUrdfPath] = useState<string | null>(null);
  const [urlModifierFunc, setUrlModifierFunc] = useState<
    ((url: string) => string) | null
  >(null);

  const packageRef = useRef<string>("");

  // Implement UrdfProcessor interface for drag and drop
  const urdfProcessor = useMemo(
    () => ({
      loadUrdf: (urdfPath: string) => {
        setCustomUrdfPath(urdfPath);
      },
      setUrlModifierFunc: (func: (url: string) => string) => {
        setUrlModifierFunc(() => func);
      },
      getPackage: () => {
        return packageRef.current;
      },
    }),
    []
  );

  // Register the URDF processor with the global drag and drop context
  useEffect(() => {
    registerUrdfProcessor(urdfProcessor);
  }, [registerUrdfProcessor, urdfProcessor]);

  // Create URL modifier function for default model
  const defaultUrlModifier = useCallback((url: string) => {
    console.log(`🔗 defaultUrlModifier called with: ${url}`);

    // Handle various package:// URL formats for the default SO-101 model
    if (url.startsWith("package://so_arm_description/meshes/")) {
      const modifiedUrl = url.replace(
        "package://so_arm_description/meshes/",
        "/so-101-urdf/meshes/"
      );
      console.log(`🔗 Modified URL (package): ${modifiedUrl}`);
      return modifiedUrl;
    }

    // Handle case where package path might be partially resolved
    if (url.includes("so_arm_description/meshes/")) {
      const modifiedUrl = url.replace(
        /.*so_arm_description\/meshes\//,
        "/so-101-urdf/meshes/"
      );
      console.log(`🔗 Modified URL (partial): ${modifiedUrl}`);
      return modifiedUrl;
    }

    // Handle the specific problematic path pattern we're seeing in logs
    if (url.includes("/so-101-urdf/so_arm_description/meshes/")) {
      const modifiedUrl = url.replace(
        "/so-101-urdf/so_arm_description/meshes/",
        "/so-101-urdf/meshes/"
      );
      console.log(`🔗 Modified URL (problematic path): ${modifiedUrl}`);
      return modifiedUrl;
    }

    // Handle relative paths that might need mesh folder prefix
    if (
      url.endsWith(".stl") &&
      !url.startsWith("/") &&
      !url.startsWith("http")
    ) {
      const modifiedUrl = `/so-101-urdf/meshes/${url}`;
      console.log(`🔗 Modified URL (relative): ${modifiedUrl}`);
      return modifiedUrl;
    }

    console.log(`🔗 Unmodified URL: ${url}`);
    return url;
  }, []);

  // Main effect to create and setup the viewer only once
  useEffect(() => {
    if (!containerRef.current) return;

    // Create and configure the URDF viewer element
    const viewer = createUrdfViewer(containerRef.current, true);
    viewerRef.current = viewer; // Store reference to the viewer

    // Setup mesh loading function with appropriate URL modifier
    const activeUrlModifier = isDefaultModel
      ? defaultUrlModifier
      : urlModifierFunc;
    setupMeshLoader(viewer, activeUrlModifier);

    // Determine which URDF to load - fixed path to match the actual available file
    const urdfPath = isDefaultModel
      ? "/so-101-urdf/urdf/so101_new_calib.urdf"
      : customUrdfPath || "";

    // Set the package path for the default model
    if (isDefaultModel) {
      packageRef.current = "/"; // Set to root so we can handle full path resolution in URL modifier
    }

    // Setup model loading if a path is available
    let cleanupModelLoading = () => {};
    if (urdfPath) {
      cleanupModelLoading = setupModelLoading(
        viewer,
        urdfPath,
        packageRef.current,
        setCustomUrdfPath,
        alternativeUrdfModels
      );
    }

    // Setup joint highlighting
    const cleanupJointHighlighting = setupJointHighlighting(
      viewer,
      setHighlightedJoint
    );

    // Function to fit the robot to the camera view
    const fitRobotToView = (viewer: URDFViewerElement) => {
      if (!viewer || !viewer.robot) {
        console.log(
          "[RobotViewer] Cannot fit to view: No viewer or robot available"
        );
        return;
      }

      try {
        // Create a bounding box for the robot (both arms when bimanual: they
        // share viewer.robot's parent)
        const framed = bimanual && viewer.robot.parent ? viewer.robot.parent : viewer.robot;
        const boundingBox = new THREE.Box3().setFromObject(framed);

        // Calculate the center of the bounding box
        const center = new THREE.Vector3();
        boundingBox.getCenter(center);

        // Calculate the size of the bounding box
        const size = new THREE.Vector3();
        boundingBox.getSize(size);

        // Get the maximum dimension to ensure the entire robot is visible
        const maxDim = Math.max(size.x, size.y, size.z);

        // Rescale the ground grid to this robot's actual unit scale — it
        // starts as a 1x1 placeholder since it's created before any model
        // is loaded (see createUrdfViewer).
        fitGridToRobot(viewer, center, boundingBox.min.y, maxDim);

        // Position camera to see the center of the model
        viewer.camera.position.copy(center);

        // Move the camera back to see the entire robot
        // Use the model's up direction to determine which axis to move along
        const upVector = new THREE.Vector3();
        if (viewer.up === "+Z" || viewer.up === "Z") {
          upVector.set(1, 1, 1); // Move back in a diagonal
        } else if (viewer.up === "+Y" || viewer.up === "Y") {
          upVector.set(1, 1, 1); // Move back in a diagonal
        } else {
          upVector.set(1, 1, 1); // Default direction
        }

        // Normalize the vector and multiply by the size
        upVector.normalize().multiplyScalar(maxDim * 1.3);
        viewer.camera.position.add(upVector);

        // Make the camera look at the center of the model
        viewer.controls.target.copy(center);

        // Update controls and mark for redraw
        viewer.controls.update();
        viewer.redraw();

        console.log("[RobotViewer] Robot auto-fitted to view");
      } catch (error) {
        console.error("[RobotViewer] Error fitting robot to view:", error);
      }
    };

    // Add event listener for when the robot is loaded to auto-fit to view
    const onRobotLoad = () => {
      fitRobotToView(viewer);
    };

    let cleanupJog = () => {};

    // Setup animation event handler for the default model or when hasAnimation is true
    const onModelProcessed = () => {
      hasInitializedRef.current = true;
      rightRobotRef.current = null;
      // Bimanual: copy the loaded arm and stand the two side by side,
      // BIMANUAL_SPACING_M apart. Only the default SO-101 model streams joints.
      if (bimanual && isDefaultModel && viewer.robot) {
        try {
          const left = viewer.robot as unknown as JointedRobot;
          const right = placeBimanualArms(left, BIMANUAL_SPACING_M);
          addArmLabel(left, "Left");
          addArmLabel(right, "Right");
          rightRobotRef.current = right;
          viewer.redraw();
        } catch (error) {
          console.error("[RobotViewer] Could not place the second arm:", error);
        }
      }
      // View mode: no arm reacts to the pointer (orbiting still works).
      // Jog mode: either arm can be dragged; its pose is reported while held.
      cleanupJog();
      cleanupJog = () => {};
      heldArmRef.current = null;
      if (viewer.robot) {
        const arms = {
          left: viewer.robot as unknown as JointedRobot,
          right: rightRobotRef.current ?? undefined,
        };
        const jog = mode === "jog" && isDefaultModel;
        setPickable(arms.left, jog);
        if (arms.right) setPickable(arms.right, jog);
        if (jog) {
          cleanupJog = installJogDragging(viewer as unknown as JogViewer, arms, {
            onHold: (arm, joints) => {
              heldArmRef.current = arm;
              jogHandlersRef.current.onJogHold?.(arm, joints);
            },
            onRelease: (arm) => {
              heldArmRef.current = null;
              jogHandlersRef.current.onJogRelease?.(arm);
            },
          });
        }
      }
      if ("setJointValue" in viewer) {
        // Clear any existing animation
        if (cleanupAnimationRef.current) {
          cleanupAnimationRef.current();
          cleanupAnimationRef.current = null;
        }
      }
      // Auto-fit the robot to view when the model is processed
      onRobotLoad();
    };

    viewer.addEventListener("urdf-processed", onModelProcessed);

    // Return cleanup function
    return () => {
      if (cleanupAnimationRef.current) {
        cleanupAnimationRef.current();
        cleanupAnimationRef.current = null;
      }
      hasInitializedRef.current = false;
      rightRobotRef.current = null;
      cleanupJog();
      heldArmRef.current = null;
      cleanupJointHighlighting();
      cleanupModelLoading();
      viewer.removeEventListener("urdf-processed", onModelProcessed);
    };
  }, [
    isDefaultModel,
    customUrdfPath,
    urlModifierFunc,
    defaultUrlModifier,
    alternativeUrdfModels,
    bimanual,
    mode,
  ]);

  return (
    <div
      className={cn(
        "w-full h-full transition-all duration-300 ease-in-out relative",
        "bg-gradient-to-br from-gray-900 to-gray-800"
      )}
    >
      <div ref={containerRef} className="w-full h-full" />

      {bimanual && (
        <div className="absolute top-4 left-4 z-10 rounded-md bg-black/70 px-3 py-2 text-sm font-medium text-gray-200">
          Two arms · {Math.round(BIMANUAL_SPACING_M * 100)} cm apart
        </div>
      )}

      {/* Joint highlight indicator */}
      {highlightedJoint && (
        <div className="absolute bottom-4 right-4 bg-black/70 text-white px-3 py-2 rounded-md text-sm font-mono z-10">
          Joint: {highlightedJoint}
        </div>
      )}

      {/* WebSocket connection status */}
      {isDefaultModel && (
        <div className="absolute top-4 right-4 z-10">
          <div
            className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-mono ${
              isWebSocketConnected
                ? "bg-green-900/70 text-green-300"
                : "bg-red-900/70 text-red-300"
            }`}
          >
            <div
              className={`w-2 h-2 rounded-full ${
                isWebSocketConnected ? "bg-green-400" : "bg-red-400"
              }`}
            />
            {isWebSocketConnected ? "Live Robot Data" : "Disconnected"}
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(UrdfViewer);
