// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Group, Vector3 } from "three";
import URDFLoader from "urdf-loader";
import { describe, expect, it } from "vitest";
import {
  BIMANUAL_SPACING_M,
  JointedRobot,
  RIGHT_ARM_NAME,
  placeBimanualArms,
  robotLeftAxis,
  setRobotJoints,
} from "./bimanualScene";

/** A two-link toy arm whose gripper sits `reach` metres away from the base. */
const toyUrdf = (reach: [number, number, number]) => `
<robot name="toy">
  <link name="base">
    <visual><geometry><box size="0.05 0.05 0.05"/></geometry></visual>
  </link>
  <link name="gripper">
    <visual><geometry><box size="0.02 0.02 0.02"/></geometry></visual>
  </link>
  <joint name="Rotation" type="revolute">
    <origin xyz="${reach.join(" ")}" rpy="0 0 0"/>
    <parent link="base"/><child link="gripper"/>
    <axis xyz="0 0 1"/><limit lower="-3" upper="3" effort="1" velocity="1"/>
  </joint>
</robot>`;

function loadInWorld(urdf: string, parseVisual = true): { world: Group; robot: JointedRobot } {
  const loader = new URDFLoader();
  loader.parseVisual = parseVisual;
  const robot = loader.parse(urdf) as unknown as JointedRobot;
  const world = new Group();
  world.add(robot);
  return { world, robot };
}

const basePositions = (world: Group, left: JointedRobot) => {
  const right = world.getObjectByName(RIGHT_ARM_NAME)!;
  return { left: left.position.clone(), right: right.position.clone() };
};

describe("robotLeftAxis", () => {
  it("is +Y for an arm reaching along +X", () => {
    const { robot } = loadInWorld(toyUrdf([0.3, 0, 0.1]));
    const axis = robotLeftAxis(robot);
    expect(axis.x).toBeCloseTo(0);
    expect(axis.y).toBeCloseTo(1);
  });

  it("follows the arm when it faces another way", () => {
    const { robot } = loadInWorld(toyUrdf([0, -0.3, 0.1])); // reaching along -Y
    const axis = robotLeftAxis(robot);
    expect(axis.x).toBeCloseTo(1);
    expect(axis.y).toBeCloseTo(0);
  });
});

describe("placeBimanualArms", () => {
  it("stands the two arms 50 cm apart, side by side, on the same floor", () => {
    const { world, robot } = loadInWorld(toyUrdf([0.3, 0, 0.1]));
    placeBimanualArms(robot);
    const { left, right } = basePositions(world, robot);

    expect(left.distanceTo(right)).toBeCloseTo(BIMANUAL_SPACING_M);
    expect(BIMANUAL_SPACING_M).toBe(0.5);
    expect(left.y).toBeCloseTo(0.25); // left of an arm reaching +X is +Y
    expect(right.y).toBeCloseTo(-0.25);
    expect(left.x).toBeCloseTo(right.x); // side by side, not one behind the other
    expect(left.z).toBeCloseTo(right.z); // same floor
  });

  it("gives the right arm its own joints and materials", () => {
    const { robot } = loadInWorld(toyUrdf([0.3, 0, 0.1]));
    const right = placeBimanualArms(robot);

    setRobotJoints(right, { Rotation: 1.2 });
    expect(right.joints.Rotation).not.toBe(robot.joints.Rotation);
    expect((right.joints.Rotation as unknown as { angle: number }).angle).toBeCloseTo(1.2);
    expect((robot.joints.Rotation as unknown as { angle: number }).angle).toBeCloseTo(0);

    const material = (root: JointedRobot) => {
      let m: unknown = null;
      root.traverse((o) => {
        if (!m && (o as { isMesh?: boolean }).isMesh) m = (o as unknown as { material: unknown }).material;
      });
      return m;
    };
    expect(material(right)).not.toBe(material(robot));
  });

  it("replaces rather than stacks copies when the model reloads", () => {
    const { world, robot } = loadInWorld(toyUrdf([0.3, 0, 0.1]));
    placeBimanualArms(robot);
    robot.position.set(0, 0, 0);
    placeBimanualArms(robot);
    expect(world.children.filter((c) => c.name === RIGHT_ARM_NAME)).toHaveLength(1);
  });

  it("places the real SO-101 arms 50 cm apart, perpendicular to their reach", () => {
    const urdf = readFileSync(resolve(__dirname, "../../public/so-101-urdf/urdf/so101_new_calib.urdf"), "utf8");
    const { world, robot } = loadInWorld(urdf, false);
    const forward = robot.links!.gripper.getWorldPosition(new Vector3()).setZ(0).normalize();

    placeBimanualArms(robot);
    const { left, right } = basePositions(world, robot);
    const between = left.clone().sub(right);

    expect(between.length()).toBeCloseTo(0.5);
    expect(between.z).toBeCloseTo(0);
    expect(between.normalize().dot(forward)).toBeCloseTo(0); // beside each other, not in line
  });
});
