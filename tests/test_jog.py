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
"""3D jog: drive the follower(s) from the 3D view, hold-to-move and capped."""

from __future__ import annotations

import math
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace

import pytest

URDF = Path(__file__).parent.parent / "frontend/public/so-101-urdf/urdf/so101_new_calib.urdf"


def _wait_for(condition, timeout: float = 2.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if condition():
            return True
        time.sleep(0.01)
    return condition()


class _Bus:
    def connect(self) -> None:
        pass

    def disable_torque(self) -> None:
        pass

    def write_calibration(self, calibration) -> None:
        pass


class _Arm:
    def __init__(self, port: str) -> None:
        self.config = SimpleNamespace(port=port)
        self.bus = _Bus()
        self.calibration = {}
        self.sent: list[dict] = []
        self.lock = threading.Lock()

    def send_action(self, action):
        with self.lock:
            self.sent.append(dict(action))
        return action


class _BiRobot:
    def __init__(self) -> None:
        self.left_arm = _Arm("COM2")
        self.right_arm = _Arm("COM4")
        self.cameras: dict = {}
        self.disconnected = False

    def configure(self) -> None:
        pass

    def get_observation(self):
        return {}

    def disconnect(self) -> None:
        self.disconnected = True


@pytest.fixture
def jog(monkeypatch: pytest.MonkeyPatch):
    import lelab.jog as jog

    monkeypatch.setattr(jog, "jog_active", False)
    monkeypatch.setattr(jog, "_robot", None)
    yield jog
    if jog.jog_active:
        jog.handle_stop_jog()


def _bimanual_request(jog_module):
    return jog_module.JogRequest(
        bimanual=True,
        follower_port="COM2",
        follower_config="left.json",
        right_follower_port="COM4",
        right_follower_config="right.json",
    )


def _start_fake(jog, monkeypatch: pytest.MonkeyPatch) -> tuple[_BiRobot, dict]:
    robot = _BiRobot()
    seen: dict = {}

    def fake_config(request, max_relative_target=None):
        seen["max_relative_target"] = max_relative_target
        return SimpleNamespace()

    monkeypatch.setattr(jog, "build_follower_config", fake_config)
    monkeypatch.setattr(jog, "make_robot_from_config", lambda config: robot)
    result = jog.handle_start_jog(_bimanual_request(jog))
    assert result["success"] is True, result
    return robot, seen


# --- conversion -------------------------------------------------------------


def test_limits_match_the_urdf() -> None:
    from lelab.jog import URDF_JOINT_LIMITS

    limits = {
        j.get("name"): (float(j.find("limit").get("lower")), float(j.find("limit").get("upper")))
        for j in ET.parse(URDF).getroot().iter("joint")
        if j.get("type") == "revolute"
    }
    assert limits == URDF_JOINT_LIMITS


def test_urdf_targets_become_follower_degrees() -> None:
    from lelab.jog import urdf_to_motor_action

    action = urdf_to_motor_action({"Pitch": math.radians(30), "Jaw": math.radians(50)})
    assert action == {"shoulder_lift.pos": pytest.approx(30), "gripper.pos": pytest.approx(50)}


def test_targets_are_clamped_to_the_joint_limits() -> None:
    from lelab.jog import urdf_to_motor_action

    action = urdf_to_motor_action({"Elbow": 10.0, "Rotation": -10.0})
    assert action["elbow_flex.pos"] == pytest.approx(math.degrees(1.5708))
    assert action["shoulder_pan.pos"] == pytest.approx(math.degrees(-1.91986))


@pytest.mark.parametrize("joints", [{"Nose": 0.0}, {"Pitch": float("nan")}, {"Pitch": float("inf")}])
def test_bad_targets_are_rejected(joints) -> None:
    from lelab.jog import urdf_to_motor_action

    with pytest.raises(ValueError):
        urdf_to_motor_action(joints)


# --- mutex ------------------------------------------------------------------


def test_target_without_a_session_is_refused(jog) -> None:
    result = jog.handle_jog_target(jog.JogTargetRequest(arm="left", joints={"Pitch": 0.0}))
    assert result["success"] is False


def test_jog_refuses_to_start_while_teleoperating(jog, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("lelab.teleoperate.teleoperation_active", True)
    result = jog.handle_start_jog(_bimanual_request(jog))
    assert result["success"] is False
    assert "Teleoperation" in result["message"]
    assert jog.jog_active is False


def test_other_modes_refuse_to_start_during_a_jog(jog, monkeypatch: pytest.MonkeyPatch) -> None:
    from lelab.record import RecordingRequest, handle_start_recording
    from lelab.replay import ReplayRequest, handle_start_replay
    from lelab.rollout import InferenceRequest, handle_start_inference
    from lelab.teleoperate import TeleoperateRequest, handle_start_teleoperation

    monkeypatch.setattr(jog, "jog_active", True)
    arms = {"follower_port": "COM2", "follower_config": "f.json"}
    results = [
        handle_start_teleoperation(TeleoperateRequest(leader_port="COM1", leader_config="l.json", **arms)),
        handle_start_recording(
            RecordingRequest(
                leader_port="COM1", leader_config="l.json", dataset_repo_id="x", single_task="t", **arms
            )
        ),
        handle_start_replay(ReplayRequest(dataset_repo_id="local/x", episode_index=0, **arms)),
        handle_start_inference(InferenceRequest(policy_ref="p", **arms)),
    ]
    for result in results:
        assert result["success"] is False
        assert "3D jog" in result["message"]


# --- worker -----------------------------------------------------------------


def test_jog_moves_only_the_held_arm_and_caps_each_step(jog, monkeypatch: pytest.MonkeyPatch) -> None:
    robot, seen = _start_fake(jog, monkeypatch)
    assert seen["max_relative_target"] == jog.MAX_STEP_DEG

    assert jog.handle_jog_target(jog.JogTargetRequest(arm="right", joints={"Pitch": math.radians(20)}))[
        "success"
    ]
    assert _wait_for(lambda: robot.right_arm.sent)
    assert robot.right_arm.sent[-1] == {"shoulder_lift.pos": pytest.approx(20)}
    assert robot.left_arm.sent == []


def test_jog_stops_sending_when_the_hold_lapses(jog, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jog, "TARGET_TIMEOUT_S", 0.1)
    robot, _ = _start_fake(jog, monkeypatch)

    jog.handle_jog_target(jog.JogTargetRequest(arm="left", joints={"Elbow": 0.5}))
    assert _wait_for(lambda: robot.left_arm.sent)
    time.sleep(0.25)  # past the hold window
    with robot.left_arm.lock:
        count = len(robot.left_arm.sent)
    time.sleep(0.2)
    assert len(robot.left_arm.sent) == count


def test_release_stops_the_arm_immediately(jog, monkeypatch: pytest.MonkeyPatch) -> None:
    robot, _ = _start_fake(jog, monkeypatch)
    jog.handle_jog_target(jog.JogTargetRequest(arm="left", joints={"Elbow": 0.5}))
    assert _wait_for(lambda: robot.left_arm.sent)

    assert jog.handle_jog_target(jog.JogTargetRequest(arm="left", joints=None))["success"]
    time.sleep(0.1)
    with robot.left_arm.lock:
        count = len(robot.left_arm.sent)
    time.sleep(0.15)
    assert len(robot.left_arm.sent) == count


def test_stop_releases_the_follower(jog, monkeypatch: pytest.MonkeyPatch) -> None:
    robot, _ = _start_fake(jog, monkeypatch)
    assert jog.handle_stop_jog()["success"] is True
    assert robot.disconnected is True
    assert jog.jog_active is False
    assert jog.handle_jog_target(jog.JogTargetRequest(arm="left", joints={"Pitch": 0.0}))["success"] is False


def test_single_arm_robot_has_no_right_arm(jog, monkeypatch: pytest.MonkeyPatch) -> None:
    class _Single(_Arm):
        cameras: dict = {}  # noqa: RUF012

        def configure(self) -> None:
            pass

        def get_observation(self):
            return {}

        def disconnect(self) -> None:
            pass

    single = _Single("COM2")
    monkeypatch.setattr(jog, "build_follower_config", lambda request, max_relative_target=None: None)
    monkeypatch.setattr(jog, "make_robot_from_config", lambda config: single)
    assert jog.handle_start_jog(jog.JogRequest(follower_port="COM2", follower_config="f.json"))["success"]

    refused = jog.handle_jog_target(jog.JogTargetRequest(arm="right", joints={"Pitch": 0.0}))
    assert refused["success"] is False
    jog.handle_jog_target(jog.JogTargetRequest(arm="left", joints={"Pitch": 0.0}))
    assert _wait_for(lambda: single.sent)
    assert single.sent[-1] == {"shoulder_lift.pos": pytest.approx(0)}


def test_connection_failure_releases_the_claim(jog, monkeypatch: pytest.MonkeyPatch) -> None:
    robot = _BiRobot()

    def refuse() -> None:
        raise RuntimeError("port busy")

    robot.right_arm.bus.connect = refuse
    monkeypatch.setattr(jog, "build_follower_config", lambda request, max_relative_target=None: None)
    monkeypatch.setattr(jog, "make_robot_from_config", lambda config: robot)

    result = jog.handle_start_jog(_bimanual_request(jog))

    assert result["success"] is False
    assert "right follower" in result["message"]
    assert jog.jog_active is False
