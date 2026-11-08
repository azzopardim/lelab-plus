import type { Object3D } from "three";
import type { JointedRobot } from "./bimanualScene";

export type JogArm = "left" | "right";

/** How often a held drag re-sends its targets; the backend drops them after 500 ms. */
export const JOG_HOLD_REFRESH_MS = 100;

interface DragJoint extends Object3D {
  setJointValue: (...values: number[]) => boolean;
}

/** The parts of urdf-loader's URDFDragControls this module overrides. */
interface DragControls {
  updateJoint: (joint: DragJoint, angle: number) => void;
  onDragStart: (joint: DragJoint) => void;
  onDragEnd: (joint: DragJoint) => void;
}

export interface JogViewer {
  dragControls?: DragControls;
  redraw: () => void;
}

/** Current joint angles of one robot (URDF names, radians). */
export function readRobotJoints(robot: JointedRobot): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, joint] of Object.entries(robot.joints)) {
    const angle = (joint as unknown as { angle?: number; jointType?: string }).angle;
    const type = (joint as unknown as { jointType?: string }).jointType;
    if (type !== "fixed" && typeof angle === "number") out[name] = angle;
  }
  return out;
}

/** Make a robot ignore (or react to) the pointer: no hover highlight, no drag. */
export function setPickable(robot: Object3D, pickable: boolean): void {
  robot.traverse((obj) => {
    const saved = obj.userData.__lelabRaycast as Object3D["raycast"] | undefined;
    if (pickable) {
      if (saved) {
        obj.raycast = saved;
        delete obj.userData.__lelabRaycast;
      }
    } else if (!saved) {
      obj.userData.__lelabRaycast = obj.raycast;
      obj.raycast = () => {};
    }
  });
}

function armOf(joint: Object3D, arms: Partial<Record<JogArm, JointedRobot>>): JogArm | null {
  for (let node: Object3D | null = joint; node; node = node.parent) {
    if (node === arms.left) return "left";
    if (node === arms.right) return "right";
  }
  return null;
}

interface JogHandlers {
  /** Called on grab and every JOG_HOLD_REFRESH_MS while held, with the arm's full pose. */
  onHold: (arm: JogArm, joints: Record<string, number>) => void;
  /** Called once when the drag ends. */
  onRelease: (arm: JogArm) => void;
}

/**
 * Let the viewer's drag controls jog either arm.
 *
 * urdf-loader routes a drag to viewer.setJointValue(jointName), which only
 * knows the viewer's own robot. Here the grabbed joint object is moved
 * directly, so a drag on the right arm's copy moves the right arm, and the
 * owning arm is reported to `onHold` while the button stays down.
 * Returns a cleanup that restores the original drag behaviour.
 */
export function installJogDragging(
  viewer: JogViewer,
  arms: Partial<Record<JogArm, JointedRobot>>,
  { onHold, onRelease }: JogHandlers,
): () => void {
  const controls = viewer.dragControls;
  if (!controls) return () => {};

  const original = {
    updateJoint: controls.updateJoint,
    onDragStart: controls.onDragStart,
    onDragEnd: controls.onDragEnd,
  };
  let held: JogArm | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const send = () => {
    const robot = held ? arms[held] : undefined;
    if (held && robot) onHold(held, readRobotJoints(robot));
  };
  const release = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (held) onRelease(held);
    held = null;
  };

  controls.updateJoint = (joint, angle) => {
    if (joint.setJointValue(angle)) viewer.redraw();
  };
  controls.onDragStart = (joint) => {
    original.onDragStart.call(controls, joint);
    release();
    held = armOf(joint, arms);
    if (!held) return;
    send();
    timer = setInterval(send, JOG_HOLD_REFRESH_MS);
  };
  controls.onDragEnd = (joint) => {
    release();
    original.onDragEnd.call(controls, joint);
  };

  return () => {
    release();
    Object.assign(controls, original);
  };
}
