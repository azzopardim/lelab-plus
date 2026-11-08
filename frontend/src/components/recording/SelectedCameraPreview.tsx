import React from "react";
import BrowserCameraPreview from "@/components/control/BrowserCameraPreview";
import type { AvailableCamera } from "@/hooks/useAvailableCameras";

interface Props {
  /** The camera picked in the "Add Camera" dropdown, or null before a pick. */
  camera: AvailableCamera | null;
  /** True while a recording claims the devices, so the browser stream is dropped. */
  paused?: boolean;
}

/**
 * Live look at the camera picked in the "Add Camera" dropdown, so the user can
 * check it is the right device before naming and adding it. Uses the same
 * browser stream as the configured-camera cards; once the camera is added the
 * selection clears and its card takes over the preview.
 */
const SelectedCameraPreview: React.FC<Props> = ({ camera, paused = false }) => {
  if (!camera) return null;
  return (
    <div className="space-y-2" data-testid="selected-camera-preview">
      <p className="text-xs text-gray-400">
        Preview · <span className="text-gray-300">{camera.name}</span> (index {camera.index})
      </p>
      <div className="max-w-sm overflow-hidden rounded-md border border-gray-700">
        <BrowserCameraPreview
          deviceId={camera.deviceId}
          paused={paused}
          fallback={
            paused
              ? "Preview paused"
              : camera.deviceId
                ? undefined
                : "The browser can't open this camera, so it can't be previewed here"
          }
        />
      </div>
    </div>
  );
};

export default SelectedCameraPreview;
