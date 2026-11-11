<h1 align="center">🦾 LeLab+</h1>

<p align="center">
  <b>An extended fork of the LeLab graphical interface for <a href="https://github.com/huggingface/lerobot">LeRobot</a>.</b>
</p>

<div align="center">

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://github.com/azzopardim/lelab-plus/blob/main/LICENSE)
[![HF Space](https://img.shields.io/badge/🤗-Open%20in%20Spaces-yellow)](https://huggingface.co/spaces/lerobot/LeLab)
[![Discord](https://img.shields.io/badge/Discord-Join_Us-5865F2?style=flat&logo=discord&logoColor=white)](https://discord.gg/q8Dzzpym3f)

</div>

**LeLab+** builds on [Hugging Face LeLab](https://github.com/huggingface/leLab), adding bimanual SO-101 support and direct 3D joint control. It is a web app that puts the full LeRobot workflow — calibrate, teleoperate, record, train, replay — into a single browser UI. Plug in your arm, open the app, and go. No CLI gymnastics, no keyboard prompts.

🤗 A web-native front door to LeRobot, designed so newcomers can get from "unboxing" to "training their first policy" in minutes.

🤗 Install and run everything with a single command.

## Quick Start

Install this fork with **Python 3.12 or newer** and Git available:

```bash
python -m pip install "git+https://github.com/azzopardim/lelab-plus.git"
lelab
```

The installer builds the frontend and installs LeRobot from its pinned `v0.7.0` Git ref. The `lelab` command serves the app at `http://localhost:8000` and opens your browser.

The [upstream LeLab Space](https://huggingface.co/spaces/lerobot/LeLab) provides the original project's demo and installer; use the repository command above to install LeLab+.

## Enhancements in LeLab+

| Enhancement | What it adds |
| --- | --- |
| Bimanual SO-101 robots | Two leader/follower pairs in one saved robot configuration: left leader controls left follower, right leader controls right follower. |
| Per-arm setup and calibration | Separate ports and calibration selections for left/right leaders and followers, with validation of required fields and distinct ports. |
| Bimanual workflows | Teleoperation, recording, replay, and policy inference construct LeRobot bimanual configurations. Replay checks that episode action keys match the selected robot. |
| Dual-arm visualization | Both arms appear in the same 3D scene with independent joint updates and a fixed 50 cm base spacing. |
| Move in 3D | Hold and drag joints in the 3D view to move one or both followers without a leader. |
| Camera setup preview | Preview the selected browser camera while adding it to the configuration. |
| LeLab+ branding | Updated app identity and footer for this fork. |

### Set up a bimanual robot

1. Create or select a robot on the home page and open **Configure**.
2. Enable bimanual mode and assign distinct serial ports to the left and right leaders and followers.
3. Calibrate each arm separately and select its calibration file. Teleoperation requires all four arms to be configured.
4. Start **Teleoperation** to control both followers from their corresponding leaders, or use the recording, replay, and inference workflows with the bimanual robot selected.

Single-arm configurations remain supported. **Move in 3D** requires only the follower ports and calibration files, including both followers for a bimanual robot.

### Move in 3D

Choose **Move in 3D** on the robot tile, then hold and drag a joint on the arm you want to move. The teleoperation viewer displays live joint positions; direct dragging is enabled in the separate jog mode.

- Targets refresh approximately every 100 ms while dragging. Releasing the drag clears that arm's target; targets older than 500 ms are discarded if updates stop arriving.
- Each command is limited to 2 degrees from the current motor position at a 30 Hz loop rate, giving a nominal maximum of 60 degrees per second per joint. Targets are clamped to the SO-101 URDF joint limits.
- Teleoperation, recording, replay, inference, and jog share follower access; stop the current mode before starting another.
- **Stop** ends the session and disconnects the followers, disabling torque. Support the arms before stopping. Leaving the page also attempts to stop the session.

The 3D scene uses a fixed visual layout; it does not measure the physical distance between your arms or provide collision avoidance. Jog limits and target expiry are software controls, not an emergency stop.

### Configuration and compatibility changes

Saved bimanual robot records use `bimanual: true`. Existing unprefixed port and calibration fields refer to the left pair; `right_*` fields describe the right pair. Existing single-arm clients keep their original fields.

The backend uses LeRobot's `bi_so_leader` and `bi_so_follower` devices and stages each selected calibration file under the corresponding bimanual calibration directory as `lelab_left.json` or `lelab_right.json`. These generated copies are overwritten when starting a workflow; manage calibration through the UI.

Bimanual joint and action keys use `left_` and `right_` prefixes, while camera keys remain unprefixed. Live joint messages include `arms.left` and `arms.right`; the existing `joints` field mirrors the left arm. Single-arm recordings and policies should not be assumed compatible with bimanual action layouts.

## What you can do

<div align="center">
  <table>
    <tr>
      <td>🎯 <b>Calibrate</b></td>
      <td>Guided web flow for both arms — no keyboard prompts.</td>
    </tr>
    <tr>
      <td>🕹️ <b>Teleoperate</b></td>
      <td>Move the leader, the follower mirrors it. Live joint streaming.</td>
    </tr>
    <tr>
      <td>📹 <b>Record</b></td>
      <td>Capture episodes into a LeRobotDataset, with cameras.</td>
    </tr>
    <tr>
      <td>🔎 <b>Browse</b></td>
      <td>Watch the episodes of a dataset on disk — every camera, frame by frame, with a joint-motion trace. No upload required.</td>
    </tr>
    <tr>
      <td>🧠 <b>Train</b></td>
      <td>Kick off a LeRobot training job, watch logs live.</td>
    </tr>
    <tr>
      <td>🤖 <b>Run inference</b></td>
      <td>Execute a trained policy on the follower.</td>
    </tr>
    <tr>
      <td>⏪ <b>Replay</b></td>
      <td>Re-run any recorded episode.</td>
    </tr>
    <tr>
      <td>☁️ <b>Upload</b></td>
      <td>Push your dataset to the <a href="https://huggingface.co/">Hugging Face Hub</a> in one click.</td>
    </tr>
  </table>
</div>

## Camera rotation

If a camera is mounted upside down or sideways, select its **Rotation** in the camera setup on the Calibration page.
Choose 0°, 90°, 180°, or 270° clockwise. For an upside-down wrist camera, choose 180°.

LeLab saves the rotation for each camera. Setup and teleoperation previews, recorded frames, and inference use the selected rotation.
Profiles without a rotation setting use 0°.

The resolution setting describes the camera's capture resolution. A 90° or 270° rotation swaps the output dimensions.
For example, a 640 × 480 capture becomes a 480 × 640 observation. The preview shows the complete rotated frame.

Before inference, select the same rotation used for the training dataset. Check it again if you change the camera binding.
Checkpoint image dimensions do not establish image orientation. For example, 0° and 180° have the same dimensions.
The setting applies to new observations; it does not change existing recordings or checkpoints.

## Future improvements

These are proposed next steps, not implemented features or committed release dates:

- **Physical workspace configuration:** adjustable base spacing and orientation so the 3D scene can match the real setup.
- **Motion controls:** configurable jog speed and step limits, clearer connection/torque status, and additional stop and recovery controls.
- **Collision awareness:** workspace boundaries and checks for arm-to-arm or environment collisions before executing motion.
- **Broader hardware support:** configurable robot models and joint mappings beyond the current SO-101 target.
- **Bimanual dataset and policy guidance:** clearer compatibility checks and examples for recording, training, and deploying dual-arm policies.
- **Hardware validation and regression coverage:** longer running dual-arm sessions, connection-loss and shutdown tests, and end-to-end browser tests across supported platforms.

## Resources

- **[LeLab+ repository](https://github.com/azzopardim/lelab-plus):** source code, issues, and contributions for this fork.
- **[Upstream LeLab](https://github.com/huggingface/leLab):** the original graphical interface.
- **[LeRobot](https://github.com/huggingface/lerobot):** the underlying robotics library.
- **[Upstream LeLab Space](https://huggingface.co/spaces/lerobot/LeLab):** try the original UI in your browser.
- **[Discord](https://discord.gg/q8Dzzpym3f):** chat with the LeRobot community.
- **[CLAUDE.md](CLAUDE.md):** architecture and implementation notes for contributors.

## Contribute

PRs welcome. For a local development checkout, use Python 3.12+ and Node.js 22.12+:

```bash
git clone https://github.com/azzopardim/lelab-plus.git
cd lelab-plus
python -m venv .venv
# Activate .venv for your shell before continuing.
python -m pip install -e ".[test]"
cd frontend
npm ci
cd ..
lelab --dev
```

Development mode runs Vite on `:8080` and uvicorn with reload on `:8000`. Editable installs skip the frontend build; use `lelab --rebuild` to build and try the production bundle. Do not commit `frontend/dist`.

Run backend tests from the repository root and frontend tests/build from `frontend/`:

```bash
python -m pytest
cd frontend
npm test
npm run build
```

Tests cover bimanual request validation, calibration staging, joint payloads, jog controls, and frontend helpers. Automated checks do not replace testing motion on real hardware.

## Credits

LeLab+ extends the work of the [upstream LeLab](https://github.com/huggingface/leLab) and [LeRobot](https://github.com/huggingface/lerobot) teams at Hugging Face. LeLab began with Team LeLab at the 2025 LeRobot Worldwide Hackathon. This fork retains the Apache 2.0 license; see [LICENSE](LICENSE).
