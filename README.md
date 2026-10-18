# Pineagent

**A shared coding workspace with an AI agent you can see on your desk.**

[Live app](https://pineagent.us) · [Devpost submission](https://devpost.com/software/pineagent)

Pineagent connects collaborative software development to a physical plant companion. Teammates work in the same GitHub branch while the agent's progress appears both in the browser and on an expressive ESP32-S3 robot. Planning, approval, execution and recovery become visible beyond the editor.

## What makes it different

- **Shared ownership:** live presence, a Monaco editor, file versions and single-writer locks keep people and agents coordinated. A serialized Git queue handles commits and pushes with ownership checks.
- **Bounded agent work:** Ask provides read-only answers. Code plans a concrete change, routes through a constrained execution graph, applies authorized edits and verifies them in Docker. New source files and tests are supported; existing tests stay protected.
- **Physical feedback:** the browser translates run state into animated faces, optional servo gestures and audio cues over Web Serial. A virtual companion shows the same state when no robot is connected.

## Hardware design

The plant design combines an **ESP32-S3**, a **320 × 170 ST7789 display** with 18 animated face states, **two servo arms**, a **MAX98357A I²S amplifier and speaker**, and a **piezo**. The repository includes firmware, prebuilt images and a browser test bench for checking two companion units.

Use the ESP32's native **USB** port, not COM. USB powers the controller; a separate 5 V supply powers the servos and amplifier, with a common star ground. The display uses 3.3 V, and external-power sensing gates actuator/audio commands. **Never connect external 5 V to the ESP32 5V pin.**

See the [wiring, firmware and test bench](firmware/PlantBotTestKit/README.md) and [animated display guide](firmware/PlantBotTestKit/VIEWPORT_ANIMATIONS.md). Physical checks must be performed on the assembled hardware.

## Try it

1. Open [Pineagent](https://pineagent.us), sign in through GitHub, and choose a deployment-enabled repository where you have write access.
2. Invite a collaborator to the same repository and branch. Open a file to see presence and ownership; use **Ask** for questions or **Code** for a focused implementation task.
3. Optionally connect the plant from Chrome or Edge using **Connect robot**. Review changes and test results before committing. **Log out** is available in the header and repository picker.

For a local UI demo, install Node.js 22+ and Git, then run from the repository root:

```sh
npm ci
npm run build -w @pineagent/harness
npm run dev -w @pineagent/web
```

Open `http://localhost:5173/?as=alice`; use `?as=bob` in another browser to try collaboration. This demo uses fixture repositories and scripted agent runs. Live inference, authentication and Docker execution require the configured backend.

## Inside the repository

| Area | Purpose |
| --- | --- |
| `apps/web` | React, Monaco, Socket.IO, terminal UI and Web Serial bridge |
| `services/api`, `packages/core` | Authentication, shared workspace authority, locks, Git queue and model access |
| [harness](harness/README.md) | Bounded planning, routing, execution and recovery |
| [apps/cli](apps/cli/README.md) | Rust/Ratatui client for the same authenticated workspace |
| `firmware/PlantBotTestKit` | Plant firmware, animations and hardware checks |
| `infra`, `contracts` | AWS deployment, Docker isolation and shared protocols |

The live stack uses AWS EC2, DynamoDB, Bedrock, Auth0 and GitHub. See [live validation](services/api/tests/SUBMISSION_FIX_VALIDATION.md) for observed results and remaining limits. Pineagent is a hackathon prototype; model-generated tests are not independent proof of correctness.
