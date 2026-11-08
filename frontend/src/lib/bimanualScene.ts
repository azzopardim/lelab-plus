import {
  Box3,
  CanvasTexture,
  Material,
  Mesh,
  Object3D,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";

/** Distance between the two arm bases (centre to centre), in metres. */
export const BIMANUAL_SPACING_M = 0.5;

/** Object3D.name of the right-arm copy added by placeBimanualArms. */
export const RIGHT_ARM_NAME = "leLab-right-arm";

/** The subset of urdf-loader's URDFRobot this module relies on. */
export interface JointedRobot extends Object3D {
  joints: Record<string, { setJointValue: (...values: number[]) => boolean }>;
  links?: Record<string, Object3D>;
}

const DEFAULT_LATERAL = new Vector3(0, 1, 0);

/**
 * The robot's "left" direction in its parent's frame (the URDF frame, +Z up),
 * as a unit vector in the horizontal plane.
 *
 * The SO-101 URDF doesn't state which way the arm faces, so this measures it:
 * at the zero pose the arm reaches from its base towards the gripper, which
 * gives "forward"; left is forward turned 90° counter-clockwise about +Z.
 * Falls back to +Y for a model with no gripper link.
 */
export function robotLeftAxis(robot: JointedRobot): Vector3 {
  const tip = robot.links?.gripper ?? robot.links?.jaw;
  const parent = robot.parent;
  if (!tip || !parent) return DEFAULT_LATERAL.clone();

  robot.updateMatrixWorld(true);
  const tipInParent = parent.worldToLocal(tip.getWorldPosition(new Vector3()));
  const forward = tipInParent.sub(robot.position).setZ(0);
  if (forward.lengthSq() < 1e-10) return DEFAULT_LATERAL.clone();
  forward.normalize();
  return new Vector3(-forward.y, forward.x, 0);
}

/** Copy every mesh material so highlighting one arm never tints the other. */
function cloneMaterials(root: Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((m: Material) => m.clone())
      : mesh.material.clone();
  });
}

/**
 * Turn the viewer's single loaded arm into a side-by-side pair.
 *
 * `left` (the viewer's own robot, still driven by viewer.setJointValue) moves
 * half the spacing to its left; a deep copy for the right arm goes half the
 * spacing to the right, in the same parent so both share the floor and the
 * up-axis rotation. Returns the right arm, whose joints the caller drives
 * with setRobotJoints.
 *
 * Pointer picking is left to the caller (jogControls.setPickable /
 * installJogDragging): urdf-loader's own drag handling routes a drag to
 * viewer.setJointValue(jointName), which would move the left arm instead.
 */
export function placeBimanualArms(left: JointedRobot, spacing = BIMANUAL_SPACING_M): JointedRobot {
  const parent = left.parent;
  if (!parent) throw new Error("placeBimanualArms: the robot must already be in the scene");

  parent.getObjectByName(RIGHT_ARM_NAME)?.removeFromParent();

  const base = left.position.clone();
  const offset = robotLeftAxis(left).multiplyScalar(spacing / 2);

  const right = left.clone(true) as JointedRobot;
  right.name = RIGHT_ARM_NAME;
  cloneMaterials(right);

  left.position.copy(base).add(offset);
  right.position.copy(base).sub(offset);
  parent.add(right);
  parent.updateMatrixWorld(true);
  return right;
}

/** Apply URDF joint values (radians) to a robot. Returns true if any joint moved. */
export function setRobotJoints(robot: JointedRobot, joints: Record<string, number>): boolean {
  let changed = false;
  for (const [name, value] of Object.entries(joints)) {
    const joint = robot.joints[name];
    if (joint && joint.setJointValue(value)) changed = true;
  }
  return changed;
}

/**
 * Float a "Left" / "Right" tag over an arm's base. The tag is a child of the
 * robot root, so it follows the base but not the moving joints. Skipped where
 * there is no 2D canvas (tests).
 */
export function addArmLabel(robot: Object3D, text: string): void {
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;

  canvas.width = 256;
  canvas.height = 96;
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.beginPath();
  ctx.roundRect(4, 4, 248, 88, 20);
  ctx.fill();
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "600 48px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 50);

  const sprite = new Sprite(new SpriteMaterial({ map: new CanvasTexture(canvas), depthTest: false }));
  sprite.name = `leLab-label-${text}`;
  sprite.raycast = () => {};
  sprite.renderOrder = 999;

  // Height of the arm at its current pose, measured before the label exists.
  // World space is three.js Y-up (the viewer rotates the URDF's Z-up frame).
  const height = Math.max(new Box3().setFromObject(robot).getSize(new Vector3()).y, 0.05);
  sprite.scale.set(height * 0.4, height * 0.15, 1);
  sprite.position.set(0, 0, height * 1.15); // robot-local frame: URDF +Z is up
  robot.add(sprite);
}
