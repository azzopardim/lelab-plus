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
"""Two leader/follower pairs (left + right) in one environment."""

from __future__ import annotations

import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

MOTORS = ("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper")


def _calibration_json() -> str:
    return json.dumps(
        {
            motor: {"id": i, "drive_mode": 0, "homing_offset": 0, "range_min": 500, "range_max": 3500}
            for i, motor in enumerate(MOTORS, start=1)
        }
    )


@pytest.fixture
def calibration_dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Point every calibration directory at tmp_path, with one file per arm."""
    from lelab.utils import config as cfg

    dirs = SimpleNamespace(
        leader=tmp_path / "so_leader",
        follower=tmp_path / "so_follower",
        bi_leader=tmp_path / "bi_so_leader",
        bi_follower=tmp_path / "bi_so_follower",
    )
    dirs.leader.mkdir()
    dirs.follower.mkdir()
    for name in ("robot_left", "robot_right"):
        (dirs.leader / f"{name}.json").write_text(_calibration_json())
        (dirs.follower / f"{name}.json").write_text(_calibration_json())
    monkeypatch.setattr(cfg, "LEADER_CONFIG_PATH", str(dirs.leader))
    monkeypatch.setattr(cfg, "FOLLOWER_CONFIG_PATH", str(dirs.follower))
    monkeypatch.setattr(cfg, "BIMANUAL_LEADER_CALIBRATION_PATH", str(dirs.bi_leader))
    monkeypatch.setattr(cfg, "BIMANUAL_FOLLOWER_CALIBRATION_PATH", str(dirs.bi_follower))
    return dirs


def _bimanual_fields(**overrides) -> dict:
    fields = {
        "bimanual": True,
        "leader_port": "COM1",
        "follower_port": "COM2",
        "right_leader_port": "COM3",
        "right_follower_port": "COM4",
        "leader_config": "robot_left.json",
        "follower_config": "robot_left.json",
        "right_leader_config": "robot_right.json",
        "right_follower_config": "robot_right.json",
    }
    fields.update(overrides)
    return fields


# --- request validation ----------------------------------------------------


def test_single_arm_request_ignores_right_fields() -> None:
    from lelab.teleoperate import TeleoperateRequest

    request = TeleoperateRequest(
        leader_port="COM1", follower_port="COM2", leader_config="a.json", follower_config="b.json"
    )
    assert request.bimanual is False


def test_bimanual_request_requires_the_right_arm_fields() -> None:
    from pydantic import ValidationError

    from lelab.teleoperate import TeleoperateRequest

    with pytest.raises(ValidationError, match="right_leader_port"):
        TeleoperateRequest(**_bimanual_fields(right_leader_port=""))


def test_bimanual_request_rejects_a_port_shared_by_two_arms() -> None:
    from pydantic import ValidationError

    from lelab.teleoperate import TeleoperateRequest

    with pytest.raises(ValidationError, match="COM2"):
        TeleoperateRequest(**_bimanual_fields(right_follower_port="COM2"))


def test_follower_only_request_needs_only_the_right_follower() -> None:
    from lelab.replay import ReplayRequest

    request = ReplayRequest(
        bimanual=True,
        follower_port="COM2",
        follower_config="robot_left.json",
        right_follower_port="COM4",
        right_follower_config="robot_right.json",
        dataset_repo_id="local/x",
        episode_index=0,
    )
    assert request.right_follower_port == "COM4"


# --- LeRobot configs -------------------------------------------------------


def test_bimanual_configs_load_each_arms_calibration(calibration_dirs) -> None:
    """The staged files are the ones LeRobot's BiSO devices look for, so each
    arm comes up with its own calibration (no hardware is opened)."""
    from lelab.teleoperate import TeleoperateRequest
    from lelab.utils.arms import build_follower_config, build_leader_config
    from lerobot.robots import make_robot_from_config
    from lerobot.teleoperators import make_teleoperator_from_config

    (calibration_dirs.follower / "robot_right.json").write_text(
        _calibration_json().replace('"homing_offset": 0', '"homing_offset": 7')
    )
    request = TeleoperateRequest(**_bimanual_fields())

    robot = make_robot_from_config(build_follower_config(request))
    teleop = make_teleoperator_from_config(build_leader_config(request))

    assert robot.name == "bi_so_follower"
    assert robot.left_arm.config.port == "COM2"
    assert robot.right_arm.config.port == "COM4"
    assert robot.left_arm.calibration["gripper"].homing_offset == 0
    assert robot.right_arm.calibration["gripper"].homing_offset == 7
    assert teleop.left_arm.config.port == "COM1"
    assert teleop.right_arm.config.port == "COM3"
    assert set(teleop.right_arm.calibration) == set(MOTORS)
    assert "left_shoulder_pan.pos" in robot.action_features
    assert "right_gripper.pos" in robot.action_features


def test_bimanual_cameras_keep_unprefixed_keys(calibration_dirs) -> None:
    from lelab.teleoperate import TeleoperateRequest
    from lelab.utils.arms import build_follower_config
    from lerobot.cameras.opencv import OpenCVCameraConfig

    config = build_follower_config(
        TeleoperateRequest(**_bimanual_fields()),
        cameras={"front": OpenCVCameraConfig(index_or_path=0, fps=30, width=640, height=480)},
    )
    assert set(config.cameras) == {"front"}


def test_staging_overwrites_a_stale_copy(calibration_dirs) -> None:
    from lelab.utils.config import setup_bimanual_follower_calibration_files

    calibration_dirs.bi_follower.mkdir()
    (calibration_dirs.bi_follower / "lelab_left.json").write_text("stale")

    device_id = setup_bimanual_follower_calibration_files("robot_left.json", "robot_right")

    staged = (calibration_dirs.bi_follower / f"{device_id}_left.json").read_text()
    assert staged == _calibration_json()
    assert (calibration_dirs.bi_follower / f"{device_id}_right.json").exists()


def test_staging_names_the_missing_arm(calibration_dirs) -> None:
    from lelab.utils.config import setup_bimanual_leader_calibration_files

    with pytest.raises(FileNotFoundError, match="Right leader"):
        setup_bimanual_leader_calibration_files("robot_left.json", "missing.json")


# --- joint broadcast -------------------------------------------------------


def test_joint_update_payload_carries_both_arms() -> None:
    from lelab.teleoperate import joint_update_payload

    class _Arm:
        pass

    class _BiRobot:
        left_arm = _Arm()
        right_arm = _Arm()

        def get_observation(self):
            obs = {f"left_{m}.pos": 0.0 for m in MOTORS}
            obs.update({f"right_{m}.pos": 0.0 for m in MOTORS})
            obs["left_shoulder_lift.pos"] = 90.0
            obs["right_elbow_flex.pos"] = -45.0
            return obs

    payload = joint_update_payload(_BiRobot(), 1.0)

    assert payload["arms"]["left"]["Pitch"] == pytest.approx(math.radians(90.0))
    assert payload["arms"]["right"]["Elbow"] == pytest.approx(math.radians(-45.0))
    assert payload["joints"] == payload["arms"]["left"]


def test_joint_update_payload_single_arm_has_no_arms_key() -> None:
    from lelab.teleoperate import joint_update_payload

    class _Robot:
        def get_observation(self):
            return {f"{m}.pos": 0.0 for m in MOTORS}

    payload = joint_update_payload(_Robot(), 1.0)
    assert "arms" not in payload
    assert set(payload["joints"]) == {"Rotation", "Pitch", "Elbow", "Wrist_Pitch", "Wrist_Roll", "Jaw"}


# --- robot records ---------------------------------------------------------


def test_bimanual_record_is_clean_only_with_all_four_arms(
    calibration_dirs, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from lelab.utils import config as cfg

    monkeypatch.setattr(cfg, "ROBOTS_PATH", str(tmp_path / "robots"))
    fields = _bimanual_fields()
    cfg.save_robot_record("duo", {**fields, "right_follower_config": ""})
    assert cfg.is_robot_record_clean(cfg.get_robot_record("duo")) is False

    cfg.save_robot_record("duo", {"right_follower_config": "robot_right.json"}, allow_create=False)
    record = cfg.get_robot_record("duo")
    assert record["bimanual"] is True
    assert cfg.is_robot_record_clean(record) is True

    # Turning bimanual off leaves the left pair as a clean single-arm robot.
    cfg.save_robot_record("duo", {"bimanual": False, "right_leader_config": ""}, allow_create=False)
    assert cfg.is_robot_record_clean(cfg.get_robot_record("duo")) is True


# --- rollout argv ----------------------------------------------------------


def test_rollout_robot_args_for_bimanual(calibration_dirs) -> None:
    from lelab.rollout import InferenceRequest, _robot_args

    args = _robot_args(
        InferenceRequest(
            bimanual=True,
            follower_port="COM2",
            follower_config="robot_left.json",
            right_follower_port="COM4",
            right_follower_config="robot_right.json",
            policy_ref="p",
        )
    )

    assert "--robot.type=bi_so_follower" in args
    assert "--robot.left_arm_config.port=COM2" in args
    assert "--robot.right_arm_config.port=COM4" in args
    assert f"--robot.calibration_dir={calibration_dirs.bi_follower}" in args
    assert (calibration_dirs.bi_follower / "lelab_right.json").exists()


# --- cleanup and replay guards ---------------------------------------------


def test_force_close_releases_both_arms_buses() -> None:
    import logging

    from lelab.utils.devices import safe_disconnect_device

    class _Bus:
        def __init__(self) -> None:
            self.closed = False

        def disconnect(self) -> None:
            self.closed = True

    class _Arm:
        def __init__(self) -> None:
            self.bus = _Bus()
            self.cameras: dict = {}

    class _BiDevice:
        def __init__(self) -> None:
            self.left_arm = _Arm()
            self.right_arm = _Arm()
            self.cameras: dict = {}

        def disconnect(self) -> None:
            raise RuntimeError("not connected")

    device = _BiDevice()
    safe_disconnect_device(device, logging.getLogger(__name__))

    assert device.left_arm.bus.closed
    assert device.right_arm.bus.closed


def test_replay_refuses_a_single_arm_episode_on_a_bimanual_robot() -> None:
    from lelab.replay import _check_actions_match_robot

    robot = SimpleNamespace(
        left_arm=object(),
        action_features={f"{side}_{m}.pos": float for side in ("left", "right") for m in MOTORS},
    )
    with pytest.raises(ValueError, match="single-arm robot and can't be replayed on a two-arm robot"):
        _check_actions_match_robot([{f"{m}.pos": 0.0 for m in MOTORS}], robot)


def test_jog_step_cap_reaches_both_follower_arms(calibration_dirs) -> None:
    from lelab.replay import ReplayRequest
    from lelab.utils.arms import build_follower_config
    from lerobot.robots import make_robot_from_config

    request = ReplayRequest(
        bimanual=True,
        follower_port="COM2",
        follower_config="robot_left.json",
        right_follower_port="COM4",
        right_follower_config="robot_right.json",
        dataset_repo_id="local/x",
        episode_index=0,
    )
    robot = make_robot_from_config(build_follower_config(request, max_relative_target=2.0))
    assert robot.left_arm.config.max_relative_target == 2.0
    assert robot.right_arm.config.max_relative_target == 2.0
    # Teleoperation keeps LeRobot's default: no cap.
    assert make_robot_from_config(build_follower_config(request)).left_arm.config.max_relative_target is None
