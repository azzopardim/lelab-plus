# Copyright 2025 The HuggingFace Inc. team. All rights reserved.
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

import logging
import math
import threading
import time
from typing import Any

from pydantic import BaseModel

from lerobot.robots import make_robot_from_config
from lerobot.teleoperators import make_teleoperator_from_config

from .utils.arms import (
    BimanualArmsFields,
    arms_of,
    build_follower_config,
    build_leader_config,
    connect_buses,
    write_calibration,
)
from .utils.devices import follower_lock, safe_disconnect_device

logger = logging.getLogger(__name__)

# Global variables for teleoperation state
teleoperation_active = False
teleoperation_thread: threading.Thread | None = None
current_robot = None
current_teleop = None


class TeleoperateRequest(BimanualArmsFields, BaseModel):
    """Single arm by default; with ``bimanual`` the unprefixed fields are the
    left pair and the ``right_*`` fields the right pair."""

    leader_port: str
    follower_port: str
    leader_config: str
    follower_config: str


_MOTOR_TO_URDF = {
    "shoulder_pan": "Rotation",
    "shoulder_lift": "Pitch",
    "elbow_flex": "Elbow",
    "wrist_flex": "Wrist_Pitch",
    "wrist_roll": "Wrist_Roll",
    "gripper": "Jaw",
}


def _urdf_joints(observation: dict, prefix: str = "") -> dict[str, float]:
    """URDF joint name -> radians for one arm of an observation (same mapping
    as get_joint_positions_from_robot)."""
    joint_positions: dict[str, float] = {}
    for motor_name, urdf_joint_name in _MOTOR_TO_URDF.items():
        motor_key = f"{prefix}{motor_name}.pos"
        if motor_key not in observation:
            logger.warning(f"Motor {motor_key} not found in observation")
            joint_positions[urdf_joint_name] = 0.0
            continue
        joint_positions[urdf_joint_name] = observation[motor_key] * math.pi / 180.0
    return joint_positions


def get_arm_joint_positions(robot) -> dict[str, dict[str, float]]:
    """{"left": joints, "right": joints} for a bimanual robot, from a single
    observation read covering both arms."""
    try:
        observation = robot.get_observation()
    except Exception as e:
        logger.error(f"Error getting joint positions: {e}")
        observation = {}
    return {side: _urdf_joints(observation, f"{side}_") for side in ("left", "right")}


def joint_update_payload(robot, timestamp: float) -> dict[str, Any]:
    """The /ws/joint-data message. ``joints`` stays the arm a single-arm viewer
    renders (the left one when bimanual); bimanual robots add ``arms`` with
    both sides."""
    if not arms_of(robot)[0][0]:
        return {
            "type": "joint_update",
            "joints": get_joint_positions_from_robot(robot),
            "timestamp": timestamp,
        }
    arms = get_arm_joint_positions(robot)
    return {"type": "joint_update", "joints": arms["left"], "arms": arms, "timestamp": timestamp}


def get_joint_positions_from_robot(robot) -> dict[str, float]:
    """
    Extract current joint positions from a single-arm robot and convert to URDF joint format.

    lerobot drives the SO-101 with ``use_degrees=True`` by default, so each
    ``observation["<motor>.pos"]`` is already the joint angle in degrees relative
    to the calibration center — which is also the URDF's zero pose. The URDF
    joint value is therefore just that angle converted to radians, for every
    joint. (The gripper reports 0–100 rather than degrees, but that range lands
    inside the Jaw limit, matching the open/closed sweep.)

    Args:
        robot: The robot instance (SO101Follower)

    Returns:
        Dictionary mapping URDF joint names to radian values
    """
    motor_to_urdf_mapping = {
        "shoulder_pan": "Rotation",
        "shoulder_lift": "Pitch",
        "elbow_flex": "Elbow",
        "wrist_flex": "Wrist_Pitch",
        "wrist_roll": "Wrist_Roll",
        "gripper": "Jaw",
    }

    try:
        observation = robot.get_observation()

        joint_positions: dict[str, float] = {}
        debug_rows = []
        for motor_name, urdf_joint_name in motor_to_urdf_mapping.items():
            motor_key = f"{motor_name}.pos"
            if motor_key not in observation:
                logger.warning(f"Motor {motor_key} not found in observation")
                joint_positions[urdf_joint_name] = 0.0
                continue

            angle_degrees = observation[motor_key]
            joint_positions[urdf_joint_name] = angle_degrees * math.pi / 180.0
            debug_rows.append(f"{motor_name:14s} {angle_degrees:+8.2f}° → {urdf_joint_name:11s}")

        # Throttled debug print (~once per second at 20 Hz broadcast).
        now = time.time()
        if now - getattr(get_joint_positions_from_robot, "_last_log", 0) > 1.0:
            get_joint_positions_from_robot._last_log = now
            logger.info("[joint-debug]\n  " + "\n  ".join(debug_rows))

        return joint_positions

    except Exception as e:
        logger.error(f"Error getting joint positions: {e}")
        return dict.fromkeys(motor_to_urdf_mapping.values(), 0.0)


def _safe_disconnect(device) -> None:
    """Disconnect a robot/teleop device, swallowing (but logging) any error.

    Used on the connection-failure cleanup path so one device's failure can't
    leave the other holding its serial port open.
    """
    safe_disconnect_device(device, logger)


def handle_start_teleoperation(request: TeleoperateRequest, websocket_manager=None) -> dict[str, Any]:
    """Handle start teleoperation request.

    Connects to both arms *synchronously* so that a connection failure (arm
    unplugged, port busy, power off) is reported back to the caller, rather than
    dying silently in the worker thread while the API has already claimed
    success. Only the teleoperation loop runs in the background thread.
    """
    global teleoperation_active, teleoperation_thread, current_robot, current_teleop

    from . import jog as _jog, record as _record, replay as _replay, rollout as _rollout

    with follower_lock:
        if teleoperation_active:
            return {"success": False, "message": "Teleoperation is already active"}
        if _record.recording_active:
            return {"success": False, "message": "Recording is currently active. Stop it first."}
        if _rollout.inference_active:
            return {"success": False, "message": "Inference is currently active. Stop it first."}
        if _replay.replay_active:
            return {"success": False, "message": "Replay is currently active. Stop it first."}
        if _jog.jog_active:
            return {"success": False, "message": "3D jog is currently active. Stop it first."}
        teleoperation_active = True

    robot = None
    teleop_device = None
    try:
        logger.info(
            f"Starting teleoperation with leader port: {request.leader_port}, follower port: {request.follower_port}"
        )

        # Setup calibration files and build the single or bimanual configs.
        robot_config = build_follower_config(request)
        teleop_config = build_leader_config(request)

        # Connect synchronously. If either device fails to connect, clean up the
        # other (so its serial port is released) and report the error — do NOT
        # leave the caller thinking teleoperation started.
        logger.info("Initializing robot and teleop device (bimanual=%s)...", request.bimanual)
        robot = make_robot_from_config(robot_config)
        teleop_device = make_teleoperator_from_config(teleop_config)

        # Connect each arm separately so the error names which one failed and
        # tells the user what to do, instead of a generic "failed to start".
        logger.info("Connecting to follower arm(s)...")
        connect_buses(robot, "follower")
        logger.info("Connecting to leader arm(s)...")
        connect_buses(teleop_device, "leader")

        logger.info("Writing calibration to motors...")
        write_calibration(robot)
        write_calibration(teleop_device)

        # Connect cameras and configure motors
        logger.info("Connecting cameras and configuring motors...")
        for cam in robot.cameras.values():
            cam.connect()
        robot.configure()
        teleop_device.configure()
        logger.info("Successfully connected to both devices")

        current_robot = robot
        current_teleop = teleop_device

        # Stream the arms in the background; the worker owns disconnect so stop()
        # does not race the serial bus from the request thread.
        def teleoperation_worker():
            global teleoperation_active, current_robot, current_teleop

            logger.info("Starting teleoperation loop...")
            try:
                last_broadcast_time = 0
                broadcast_interval = 1 / 30  # 30 FPS

                while teleoperation_active:
                    action = teleop_device.get_action()
                    robot.send_action(action)

                    current_time = time.time()
                    if current_time - last_broadcast_time >= broadcast_interval:
                        try:
                            if websocket_manager and websocket_manager.active_connections:
                                websocket_manager.broadcast_joint_data_sync(
                                    joint_update_payload(robot, current_time)
                                )
                            last_broadcast_time = current_time
                        except Exception as e:
                            logger.error(f"Error broadcasting joint data: {e}")

                    time.sleep(0.001)
            except Exception as e:
                logger.error(f"Error during teleoperation loop: {e}")
            finally:
                _safe_disconnect(robot)
                _safe_disconnect(teleop_device)
                logger.info("Teleoperation stopped")
                teleoperation_active = False
                current_robot = None
                current_teleop = None

        teleoperation_thread = threading.Thread(
            target=teleoperation_worker, name="teleoperation-worker", daemon=True
        )
        teleoperation_thread.start()

        return {
            "success": True,
            "message": "Teleoperation started successfully",
            "leader_port": request.leader_port,
            "follower_port": request.follower_port,
            "bimanual": request.bimanual,
        }

    except Exception as e:
        # Connection (or setup) failed before the loop started: release any
        # device that did open, reset state, and surface the error.
        _safe_disconnect(robot)
        _safe_disconnect(teleop_device)
        teleoperation_active = False
        current_robot = None
        current_teleop = None
        logger.error(f"Failed to start teleoperation: {e}")
        # str(e) is already a user-facing message for the connection failures
        # raised above; the toast title supplies the "error starting" context.
        return {"success": False, "message": str(e)}


def handle_stop_teleoperation() -> dict[str, Any]:
    """Handle stop teleoperation request.

    Signals the worker via `teleoperation_active = False` and waits for it to
    exit. The worker owns the disconnect call, so this avoids racing the
    serial bus from the request thread.
    """
    global teleoperation_active, teleoperation_thread

    if not teleoperation_active:
        return {"success": False, "message": "No teleoperation session is active"}

    logger.info("Stop teleoperation triggered from web interface")
    teleoperation_active = False

    worker = teleoperation_thread
    if worker is not None and worker.is_alive():
        worker.join(timeout=5.0)
        if worker.is_alive():
            logger.warning("Teleoperation worker did not exit within 5s")
    teleoperation_thread = None

    return {"success": True, "message": "Teleoperation stopped successfully"}


def handle_teleoperation_status() -> dict[str, Any]:
    """Handle teleoperation status request"""
    return {
        "teleoperation_active": teleoperation_active,
        "available_controls": {
            "stop_teleoperation": teleoperation_active,
        },
        "message": "Teleoperation status retrieved successfully",
    }


def handle_get_joint_positions() -> dict[str, Any]:
    """Handle get current robot joint positions request"""
    global current_robot

    if not teleoperation_active or current_robot is None:
        return {"success": False, "message": "No active teleoperation session"}

    try:
        if not arms_of(current_robot)[0][0]:
            joint_positions = get_joint_positions_from_robot(current_robot)
            return {"success": True, "joint_positions": joint_positions, "timestamp": time.time()}
        arms = get_arm_joint_positions(current_robot)
        return {"success": True, "joint_positions": arms["left"], "arms": arms, "timestamp": time.time()}
    except Exception as e:
        logger.error(f"Error getting joint positions: {e}")
        return {"success": False, "message": f"Failed to get joint positions: {str(e)}"}
