# Copyright 2026 The HuggingFace Inc. team. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""3D jog: move the follower arm(s) by dragging joints in the 3D view.

No leader is involved, so this is a mode of its own, mutually exclusive with
teleoperation, recording, inference and replay (they all own the follower).

Safety model:
- Hold to move. The browser sends the dragged arm's joint targets while the
  mouse button is held and refreshes them every ~100 ms. A target older than
  TARGET_TIMEOUT_S is dropped, so the arm stops if the drag ends, the tab
  freezes or the connection drops.
- Slow. Every command is capped at MAX_STEP_DEG from the motor's present
  position (LeRobot's ``max_relative_target``), sent at LOOP_HZ: at most
  MAX_STEP_DEG * LOOP_HZ degrees per second per joint.
- Within limits. Targets are clamped to the SO-101 URDF joint limits.
- Stop disconnects the follower, which (like teleoperation) disables torque.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from typing import Any, Literal

from pydantic import BaseModel

from lerobot.robots import make_robot_from_config

from .teleoperate import _MOTOR_TO_URDF, joint_update_payload
from .utils.arms import (
    BimanualFollowerFields,
    arms_of,
    build_follower_config,
    connect_buses,
    write_calibration,
)
from .utils.devices import follower_lock, safe_disconnect_device

logger = logging.getLogger(__name__)

LOOP_HZ = 30
MAX_STEP_DEG = 2.0  # per command → at most 60 °/s per joint at 30 Hz
TARGET_TIMEOUT_S = 0.5
BROADCAST_INTERVAL_S = 1 / 20

# SO-101 joint limits (radians), from frontend/public/so-101-urdf/urdf/so101_new_calib.urdf.
URDF_JOINT_LIMITS: dict[str, tuple[float, float]] = {
    "Rotation": (-1.91986, 1.91986),
    "Pitch": (-1.74533, 1.74533),
    "Elbow": (-1.74533, 1.5708),
    "Wrist_Pitch": (-1.65806, 1.65806),
    "Wrist_Roll": (-2.79253, 2.79253),
    "Jaw": (-0.174533, 1.74533),
}
_URDF_TO_MOTOR = {urdf: motor for motor, urdf in _MOTOR_TO_URDF.items()}

ArmSide = Literal["left", "right"]

# Only the worker (or a failed start) clears jog_active, so the follower stays
# claimed until it has actually been released.
jog_active = False
jog_error: str | None = None
_thread: threading.Thread | None = None
_robot = None
_stop = threading.Event()
_targets_lock = threading.Lock()
_targets: dict[str, tuple[dict[str, float], float]] = {}  # side -> (motor action, received at)


class JogRequest(BimanualFollowerFields, BaseModel):
    follower_port: str
    follower_config: str


class JogTargetRequest(BaseModel):
    """Joint targets for one arm, in URDF joint names and radians (what the 3D
    view holds). ``joints=None`` releases the arm immediately. A single-arm
    robot only has the "left" arm."""

    arm: ArmSide = "left"
    joints: dict[str, float] | None = None


def urdf_to_motor_action(joints: dict[str, float], prefix: str = "") -> dict[str, float]:
    """URDF radians → follower ``<motor>.pos`` targets, clamped to the joint limits.

    Inverse of teleoperate._urdf_joints: each motor position is its joint angle
    in degrees (the gripper's 0–100 range included, as the 3D view maps it).
    """
    unknown = set(joints) - set(URDF_JOINT_LIMITS)
    if unknown:
        raise ValueError(f"Unknown joints: {', '.join(sorted(unknown))}")
    action: dict[str, float] = {}
    for name, value in joints.items():
        if not math.isfinite(value):
            raise ValueError(f"Joint {name} must be a finite number")
        lower, upper = URDF_JOINT_LIMITS[name]
        clamped = min(max(value, lower), upper)
        action[f"{prefix}{_URDF_TO_MOTOR[name]}.pos"] = math.degrees(clamped)
    return action


def _fresh_targets(now: float) -> dict[str, dict[str, float]]:
    """Targets still inside the hold window; stale ones are dropped."""
    with _targets_lock:
        for side in [s for s, (_, at) in _targets.items() if now - at > TARGET_TIMEOUT_S]:
            del _targets[side]
        return {side: dict(action) for side, (action, _) in _targets.items()}


def _send_targets(robot, targets: dict[str, dict[str, float]]) -> None:
    """Command each arm that has a live target; arms without one hold still."""
    for side, arm in arms_of(robot):
        action = targets.get(side or "left")
        if action:
            arm.send_action(action)


def handle_start_jog(request: JogRequest, websocket_manager=None) -> dict[str, Any]:
    global jog_active, jog_error, _thread, _robot

    from . import record as _record, replay as _replay, rollout as _rollout, teleoperate as _teleoperate

    with follower_lock:
        if jog_active:
            return {"success": False, "message": "3D jog is already active"}
        if _teleoperate.teleoperation_active:
            return {"success": False, "message": "Teleoperation is currently active. Stop it first."}
        if _record.recording_active:
            return {"success": False, "message": "Recording is currently active. Stop it first."}
        if _rollout.inference_active:
            return {"success": False, "message": "Inference is currently active. Stop it first."}
        if _replay.replay_active:
            return {"success": False, "message": "Replay is currently active. Stop it first."}
        jog_active = True
        jog_error = None
        _stop.clear()
        with _targets_lock:
            _targets.clear()

    robot = None
    try:
        robot = make_robot_from_config(build_follower_config(request, max_relative_target=MAX_STEP_DEG))
        connect_buses(robot, "follower")
        write_calibration(robot)
        # Enables torque, so the arm holds where it is until a target arrives.
        robot.configure()
    except Exception as e:
        safe_disconnect_device(robot, logger)
        jog_active = False
        logger.error(f"Failed to start 3D jog: {e}")
        return {"success": False, "message": str(e)}

    _robot = robot

    def jog_worker():
        global jog_active, jog_error, _robot

        last_broadcast = 0.0
        try:
            while not _stop.is_set():
                start = time.perf_counter()
                now = time.time()
                _send_targets(robot, _fresh_targets(now))
                if (
                    websocket_manager
                    and websocket_manager.active_connections
                    and now - last_broadcast >= BROADCAST_INTERVAL_S
                ):
                    websocket_manager.broadcast_joint_data_sync(joint_update_payload(robot, now))
                    last_broadcast = now
                _stop.wait(max(0.0, 1 / LOOP_HZ - (time.perf_counter() - start)))
        except Exception as e:
            logger.error(f"3D jog failed: {e}")
            jog_error = str(e)
        finally:
            with _targets_lock:
                _targets.clear()
            _robot = None
            safe_disconnect_device(robot, logger, context="3D jog cleanup")
            jog_active = False
            logger.info("3D jog stopped")

    _thread = threading.Thread(target=jog_worker, name="jog-worker", daemon=True)
    _thread.start()
    return {"success": True, "message": "3D jog started", "bimanual": request.bimanual}


def handle_jog_target(request: JogTargetRequest) -> dict[str, Any]:
    robot = _robot
    if not jog_active or robot is None:
        return {"success": False, "message": "3D jog is not active"}
    sides = [side or "left" for side, _ in arms_of(robot)]
    if request.arm not in sides:
        return {"success": False, "message": f"This robot has no {request.arm} arm"}

    if request.joints is None:
        with _targets_lock:
            _targets.pop(request.arm, None)
        return {"success": True, "message": f"{request.arm} arm released"}

    try:
        action = urdf_to_motor_action(request.joints)
    except ValueError as e:
        return {"success": False, "message": str(e)}
    with _targets_lock:
        _targets[request.arm] = (action, time.time())
    return {"success": True}


def handle_stop_jog() -> dict[str, Any]:
    global _thread

    if not jog_active:
        return {"success": False, "message": "3D jog is not active"}
    _stop.set()
    worker = _thread
    if worker is not None:
        worker.join(timeout=5.0)
        if worker.is_alive():
            logger.warning("3D jog worker did not exit within 5s")
            return {"success": False, "message": "3D jog has not released the arm yet"}
    _thread = None
    return {"success": True, "message": "3D jog stopped"}


def handle_jog_status() -> dict[str, Any]:
    return {"jog_active": jog_active, "error": jog_error}
