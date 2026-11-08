import { describe, expect, it } from "vitest";
import type { RobotRecord } from "@/hooks/useRobots";
import {
  armField,
  armsPayload,
  calibrationSlots,
  followerArmsPayload,
  followersReady,
  readArmField,
} from "./robotArms";

const single: RobotRecord = {
  name: "solo",
  leader_port: "COM1",
  follower_port: "COM2",
  leader_config: "solo.json",
  follower_config: "solo.json",
  cameras: [],
  is_clean: true,
};

const duo: RobotRecord = {
  ...single,
  name: "duo",
  bimanual: true,
  leader_config: "duo_left.json",
  follower_config: "duo_left.json",
  right_leader_port: "COM3",
  right_follower_port: "COM4",
  right_leader_config: "duo_right.json",
  right_follower_config: "duo_right.json",
};

describe("robotArms", () => {
  it("maps an arm to its record field", () => {
    expect(armField("left", "teleop", "port")).toBe("leader_port");
    expect(armField("right", "robot", "config")).toBe("right_follower_config");
    expect(readArmField(duo, "right", "teleop", "port")).toBe("COM3");
  });

  it("lists two slots for one arm and four for two", () => {
    expect(calibrationSlots(single).map((s) => s.label)).toEqual(["Leader (Teleoperator)", "Follower (Robot)"]);
    expect(calibrationSlots(duo).map((s) => `${s.arm}-${s.deviceType}`)).toEqual([
      "left-teleop",
      "left-robot",
      "right-teleop",
      "right-robot",
    ]);
  });

  it("keeps single-arm request bodies unchanged", () => {
    expect(armsPayload(single)).toEqual({
      leader_port: "COM1",
      leader_config: "solo.json",
      follower_port: "COM2",
      follower_config: "solo.json",
    });
  });

  it("adds the right arm and the bimanual flag for two arms", () => {
    expect(armsPayload(duo)).toMatchObject({
      bimanual: true,
      right_leader_port: "COM3",
      right_follower_port: "COM4",
      right_leader_config: "duo_right.json",
      right_follower_config: "duo_right.json",
    });
    expect(followerArmsPayload(duo)).not.toHaveProperty("right_leader_port");
  });

  it("is ready to jog once every follower is set up, leaders or not", () => {
    expect(followersReady({ ...single, leader_config: "", leader_port: "" })).toBe(true);
    expect(followersReady({ ...duo, right_follower_config: "" })).toBe(false);
    expect(followersReady({ ...duo, right_leader_port: "" })).toBe(true);
  });
});
