import type { RobotRecord } from "@/hooks/useRobots";

/** Which arm of a bimanual robot. A single-arm robot only has "left". */
export type ArmSide = "left" | "right";
/** Backend vocabulary: "teleop" is the leader, "robot" the follower. */
export type DeviceType = "teleop" | "robot";

type ArmFieldKind = "port" | "config";
type ArmField =
  | "leader_port"
  | "follower_port"
  | "leader_config"
  | "follower_config"
  | "right_leader_port"
  | "right_follower_port"
  | "right_leader_config"
  | "right_follower_config";

/** The robot-record field holding one arm's port or calibration file. */
export const armField = (arm: ArmSide, deviceType: DeviceType, kind: ArmFieldKind): ArmField => {
  const prefix = arm === "right" ? "right_" : "";
  const side = deviceType === "teleop" ? "leader" : "follower";
  return `${prefix}${side}_${kind}` as ArmField;
};

export const readArmField = (
  robot: RobotRecord,
  arm: ArmSide,
  deviceType: DeviceType,
  kind: ArmFieldKind,
): string => robot[armField(arm, deviceType, kind)] ?? "";

export interface CalibrationSlot {
  arm: ArmSide;
  deviceType: DeviceType;
  label: string;
}

/** Every arm the robot needs calibrated, in checklist order. */
export const calibrationSlots = (robot: RobotRecord | null): CalibrationSlot[] => {
  if (!robot?.bimanual) {
    return [
      { arm: "left", deviceType: "teleop", label: "Leader (Teleoperator)" },
      { arm: "left", deviceType: "robot", label: "Follower (Robot)" },
    ];
  }
  return [
    { arm: "left", deviceType: "teleop", label: "Left leader" },
    { arm: "left", deviceType: "robot", label: "Left follower" },
    { arm: "right", deviceType: "teleop", label: "Right leader" },
    { arm: "right", deviceType: "robot", label: "Right follower" },
  ];
};

/** Whether every follower arm has a port and a calibration (all 3D jog needs). */
export const followersReady = (robot: RobotRecord): boolean =>
  calibrationSlots(robot)
    .filter((s) => s.deviceType === "robot")
    .every(
      (s) => !!readArmField(robot, s.arm, "robot", "port") && !!readArmField(robot, s.arm, "robot", "config"),
    );

/** Fields the backend needs to drive the follower arm(s): replay, inference. */
export const followerArmsPayload = (robot: RobotRecord) => ({
  follower_port: robot.follower_port,
  follower_config: robot.follower_config,
  ...(robot.bimanual
    ? {
        bimanual: true,
        right_follower_port: robot.right_follower_port ?? "",
        right_follower_config: robot.right_follower_config ?? "",
      }
    : {}),
});

/** Fields the backend needs to drive leader + follower arm(s): teleop, recording. */
export const armsPayload = (robot: RobotRecord) => ({
  leader_port: robot.leader_port,
  leader_config: robot.leader_config,
  ...followerArmsPayload(robot),
  ...(robot.bimanual
    ? {
        right_leader_port: robot.right_leader_port ?? "",
        right_leader_config: robot.right_leader_config ?? "",
      }
    : {}),
});
