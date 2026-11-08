// @vitest-environment jsdom
import { Group, Raycaster, Vector3 } from "three";
import URDFLoader from "urdf-loader";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JointedRobot, placeBimanualArms } from "./bimanualScene";
import { JOG_HOLD_REFRESH_MS, installJogDragging, readRobotJoints, setPickable } from "./jogControls";

const URDF = `
<robot name="toy">
  <link name="base"><visual><geometry><box size="0.05 0.05 0.05"/></geometry></visual></link>
  <link name="gripper"><visual><geometry><box size="0.02 0.02 0.02"/></geometry></visual></link>
  <joint name="Pitch" type="revolute">
    <origin xyz="0.3 0 0.1" rpy="0 0 0"/>
    <parent link="base"/><child link="gripper"/>
    <axis xyz="0 1 0"/><limit lower="-1.5" upper="1.5" effort="1" velocity="1"/>
  </joint>
</robot>`;

type Joint = JointedRobot["joints"][string] & { angle: number };

function scene() {
  const left = new URDFLoader().parse(URDF) as unknown as JointedRobot;
  const world = new Group();
  world.add(left);
  const right = placeBimanualArms(left);
  const controls = {
    updateJoint: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
  };
  const viewer = { dragControls: controls, redraw: vi.fn() };
  return { left, right, controls, viewer };
}

const pitch = (robot: JointedRobot) => robot.joints.Pitch as unknown as Joint;

describe("installJogDragging", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("moves the grabbed arm's own joint and reports that arm while held", () => {
    const { left, right, controls, viewer } = scene();
    const onHold = vi.fn();
    const onRelease = vi.fn();
    installJogDragging(viewer, { left, right }, { onHold, onRelease });

    controls.onDragStart(pitch(right));
    controls.updateJoint(pitch(right), 0.7);

    expect(pitch(right).angle).toBeCloseTo(0.7);
    expect(pitch(left).angle).toBeCloseTo(0); // not routed to the left arm by name
    expect(onHold).toHaveBeenLastCalledWith("right", { Pitch: 0 }); // pose at grab time

    vi.advanceTimersByTime(JOG_HOLD_REFRESH_MS);
    expect(onHold).toHaveBeenLastCalledWith("right", { Pitch: expect.closeTo(0.7) });
    expect(onHold).toHaveBeenCalledTimes(2);
  });

  it("keeps re-sending while held, even without movement, then stops on release", () => {
    const { left, right, controls, viewer } = scene();
    const onHold = vi.fn();
    const onRelease = vi.fn();
    installJogDragging(viewer, { left, right }, { onHold, onRelease });

    controls.onDragStart(pitch(left));
    vi.advanceTimersByTime(JOG_HOLD_REFRESH_MS * 3);
    expect(onHold).toHaveBeenCalledTimes(4);
    expect(onHold.mock.calls.every(([arm]) => arm === "left")).toBe(true);

    controls.onDragEnd(pitch(left));
    expect(onRelease).toHaveBeenCalledWith("left");
    vi.advanceTimersByTime(JOG_HOLD_REFRESH_MS * 3);
    expect(onHold).toHaveBeenCalledTimes(4);
  });

  it("still runs the viewer's own drag start/end (orbit lock, events)", () => {
    const { left, controls, viewer } = scene();
    const start = controls.onDragStart;
    const end = controls.onDragEnd;
    installJogDragging(viewer, { left }, { onHold: vi.fn(), onRelease: vi.fn() });

    controls.onDragStart(pitch(left));
    controls.onDragEnd(pitch(left));
    expect(start).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("cleanup restores the original drag behaviour and ends a held drag", () => {
    const { left, controls, viewer } = scene();
    const original = { ...controls };
    const onRelease = vi.fn();
    const cleanup = installJogDragging(viewer, { left }, { onHold: vi.fn(), onRelease });

    controls.onDragStart(pitch(left));
    cleanup();

    expect(onRelease).toHaveBeenCalledWith("left");
    expect(controls.updateJoint).toBe(original.updateJoint);
    expect(controls.onDragStart).toBe(original.onDragStart);
  });
});

describe("setPickable", () => {
  it("turns pointer picking off and back on", () => {
    const { left } = scene();
    left.updateMatrixWorld(true);
    // Straight down onto the base, which placeBimanualArms moved to the side.
    const ray = new Raycaster(left.position.clone().setZ(1), new Vector3(0, 0, -1));
    const hits = () => ray.intersectObject(left, true).length;

    expect(hits()).toBeGreaterThan(0);
    setPickable(left, false);
    expect(hits()).toBe(0);
    setPickable(left, false); // idempotent
    setPickable(left, true);
    expect(hits()).toBeGreaterThan(0);
  });
});

describe("readRobotJoints", () => {
  it("lists the movable joints in radians", () => {
    const { left } = scene();
    pitch(left).setJointValue(0.4);
    expect(readRobotJoints(left)).toEqual({ Pitch: expect.closeTo(0.4) });
  });
});
