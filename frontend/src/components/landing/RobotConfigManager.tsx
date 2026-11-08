import React from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
import { RobotRecord } from "@/hooks/useRobots";
import { armsPayload, followerArmsPayload } from "@/lib/robotArms";
import RobotTile from "./RobotTile";

interface RobotConfigManagerProps {
  selectedName: string | null;
  selectedRecord: RobotRecord | null;
  availableNames: string[];
  isLoading: boolean;
  selectRobot: (name: string) => void;
  createRobot: (name: string) => Promise<boolean>;
  deleteRobot: (name: string) => Promise<boolean>;
}

const RobotConfigManager: React.FC<RobotConfigManagerProps> = ({
  selectedName,
  selectedRecord,
  availableNames,
  isLoading,
  selectRobot,
  createRobot,
  deleteRobot,
}) => {
  const navigate = useNavigate();
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();

  const handleConfigure = (name: string) => {
    navigate("/calibration", { state: { robot_name: name } });
  };

  const handleTeleop = async (robot: RobotRecord) => {
    try {
      const res = await fetchWithHeaders(`${baseUrl}/move-arm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(armsPayload(robot)),
      });
      const data = await res.json();
      // The backend returns HTTP 200 with `{ success: false }` for logical
      // failures (arm not connected, already active), so gate on `data.success`
      // — not just `res.ok` — or we'd navigate to an empty teleop screen.
      if (res.ok && data.success) {
        toast({
          title: "Teleoperation Started",
          description: data.message || `Started teleoperation for ${robot.name}.`,
        });
        navigate("/teleoperation", { state: { bimanual: !!robot.bimanual } });
      } else {
        toast({
          title: "Error Starting Teleoperation",
          description: data.message || "Failed to start.",
          variant: "destructive",
        });
      }
    } catch (e) {
      toast({
        title: "Connection Error",
        description: "Could not connect to the backend server.",
        variant: "destructive",
      });
    }
  };

  const handleJog = async (robot: RobotRecord) => {
    try {
      const res = await fetchWithHeaders(`${baseUrl}/start-jog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(followerArmsPayload(robot)),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        navigate("/jog", { state: { bimanual: !!robot.bimanual } });
      } else {
        toast({
          title: "Couldn't start 3D jog",
          description: data.message || (res.status === 422 ? "Check the follower ports." : "Failed to start."),
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Connection Error",
        description: "Could not connect to the backend server.",
        variant: "destructive",
      });
    }
  };

  return (
    <RobotTile
      robot={selectedRecord}
      selectedName={selectedName}
      availableNames={availableNames}
      isLoading={isLoading}
      onSelect={selectRobot}
      onCreateNew={createRobot}
      onConfigure={handleConfigure}
      onTeleop={handleTeleop}
      onJog={handleJog}
      onDelete={deleteRobot}
    />
  );
};

export default RobotConfigManager;
