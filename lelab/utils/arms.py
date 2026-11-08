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

"""Single-arm vs bimanual (two-arm) SO-101 plumbing shared by the feature modules.

A bimanual robot is two leader/follower pairs in one environment: the left
leader drives the left follower and the right leader the right follower. It
maps onto LeRobot's ``BiSOLeader`` / ``BiSOFollower``, whose actions and
observations carry ``left_`` / ``right_`` key prefixes (so a dataset recorded
here trains and rolls out like one from ``lerobot-record --robot.type=bi_so_follower``).

Request convention: the existing unprefixed fields (``leader_port``,
``follower_config``...) describe the LEFT arm pair when ``bimanual`` is true,
and the ``right_*`` fields the right pair. Single-arm requests are unchanged.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel, model_validator

from . import config as _config
from .config import (
    setup_bimanual_follower_calibration_files,
    setup_bimanual_leader_calibration_files,
    setup_calibration_files,
    setup_follower_calibration_file,
)


def _require(model: BaseModel, fields: tuple[str, ...]) -> None:
    missing = [f for f in fields if not getattr(model, f, "")]
    if missing:
        raise ValueError(f"Bimanual mode requires: {', '.join(missing)}")


def _require_distinct_ports(ports: dict[str, str]) -> None:
    seen: dict[str, str] = {}
    for label, port in ports.items():
        if port in seen:
            raise ValueError(f"The {label} and {seen[port]} arms are both set to port {port}")
        seen[port] = label


class BimanualFollowerFields(BaseModel):
    """Right follower fields for requests that drive only the follower(s)."""

    bimanual: bool = False
    right_follower_port: str = ""
    right_follower_config: str = ""

    @model_validator(mode="after")
    def _check_bimanual_follower(self):
        if self.bimanual:
            _require(self, ("right_follower_port", "right_follower_config"))
            _require_distinct_ports(
                {"left follower": self.follower_port, "right follower": self.right_follower_port}
            )
        return self


class BimanualArmsFields(BimanualFollowerFields):
    """Right leader + follower fields for requests that drive both pairs."""

    right_leader_port: str = ""
    right_leader_config: str = ""

    @model_validator(mode="after")
    def _check_bimanual_leader(self):
        if self.bimanual:
            _require(self, ("right_leader_port", "right_leader_config"))
            _require_distinct_ports(
                {
                    "left leader": self.leader_port,
                    "left follower": self.follower_port,
                    "right leader": self.right_leader_port,
                    "right follower": self.right_follower_port,
                }
            )
        return self


def build_follower_config(
    request: Any, cameras: dict | None = None, max_relative_target: float | None = None
):
    """The LeRobot robot config for the request's follower(s).

    Cameras go at the top level of a BiSOFollowerConfig so their keys stay
    unprefixed (``observation.images.front``), matching single-arm datasets and
    the rollout CLI's ``--robot.cameras``.

    ``max_relative_target`` caps how far (degrees, or gripper units) one
    command may move each motor from where it is; LeRobot re-reads the present
    position on every send_action to enforce it. None keeps LeRobot's default
    (no cap), as teleoperation does.
    """
    cameras = cameras or {}
    if getattr(request, "bimanual", False):
        from lerobot.robots.bi_so_follower import BiSOFollowerConfig
        from lerobot.robots.so_follower import SOFollowerConfig

        device_id = setup_bimanual_follower_calibration_files(
            request.follower_config, request.right_follower_config
        )
        return BiSOFollowerConfig(
            id=device_id,
            calibration_dir=Path(_config.BIMANUAL_FOLLOWER_CALIBRATION_PATH),
            left_arm_config=SOFollowerConfig(
                port=request.follower_port, max_relative_target=max_relative_target
            ),
            right_arm_config=SOFollowerConfig(
                port=request.right_follower_port, max_relative_target=max_relative_target
            ),
            cameras=cameras,
        )

    from lerobot.robots.so_follower import SO101FollowerConfig

    follower_id = setup_follower_calibration_file(request.follower_config)
    return SO101FollowerConfig(
        port=request.follower_port,
        id=follower_id,
        cameras=cameras,
        max_relative_target=max_relative_target,
    )


def build_leader_config(request: Any):
    """The LeRobot teleoperator config for the request's leader(s)."""
    if getattr(request, "bimanual", False):
        from lerobot.teleoperators.bi_so_leader import BiSOLeaderConfig
        from lerobot.teleoperators.so_leader import SOLeaderConfig

        device_id = setup_bimanual_leader_calibration_files(
            request.leader_config, request.right_leader_config
        )
        return BiSOLeaderConfig(
            id=device_id,
            calibration_dir=Path(_config.BIMANUAL_LEADER_CALIBRATION_PATH),
            left_arm_config=SOLeaderConfig(port=request.leader_port),
            right_arm_config=SOLeaderConfig(port=request.right_leader_port),
        )

    from lerobot.teleoperators.so_leader import SO101LeaderConfig

    leader_id, _ = setup_calibration_files(request.leader_config, request.follower_config)
    return SO101LeaderConfig(port=request.leader_port, id=leader_id)


def arms_of(device: Any) -> list[tuple[str, Any]]:
    """(side, single-arm device) pairs: [("left", ..), ("right", ..)] for a
    bimanual device, [("", device)] for a single arm."""
    if hasattr(device, "left_arm") and hasattr(device, "right_arm"):
        return [("left", device.left_arm), ("right", device.right_arm)]
    return [("", device)]


def connect_buses(device: Any, role: str) -> None:
    """Open each arm's serial bus, naming the arm and port that failed.

    ``role`` is "leader" or "follower". Uses the bus directly rather than
    ``device.connect()``, which prompts on stdin and ends with configure().
    """
    for side, arm in arms_of(device):
        label = f"{side} {role}" if side else role
        port = getattr(getattr(arm, "config", None), "port", "its port")
        try:
            arm.bus.connect()
        except Exception as e:
            raise RuntimeError(
                f"Could not connect to the {label} arm on {port}. "
                "Make sure it's plugged in and powered on, then try again."
            ) from e


def write_calibration(device: Any) -> None:
    """Write each arm's calibration file to its motors.

    Feetech motors only store calibration registers with the torque off,
    which also opens their EEPROM lock.
    """
    for _side, arm in arms_of(device):
        arm.bus.disable_torque()
        arm.bus.write_calibration(arm.calibration)
