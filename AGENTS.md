# Repository Guidelines

## Product Identity

- The project and product name is `Alfred AI`. Do not introduce alternative user-facing names.
- Alfred AI is a personal, non-commercial work meeting assistant with meeting prompter capabilities.
- It uses the user's personal knowledge base, background, and supplied meeting information to provide timely prompts and reduce manual note-taking or cue-card preparation.
- Preserve the legacy bundle ID `com.atlax.inview-practice`, preload API names, storage keys, and signing identity unless an explicit migration is authorized; these are compatibility identifiers, not product names.
- Naming-only work must not change meeting, prompting, note, knowledge-base, personalization, OCR, STT, LLM, stealth, or other business behavior.

## Project Structure & Module Organization

- `src/main/`: Electron lifecycle, windows, tray, IPC handlers, screen capture, and stealth behavior.
- `src/preload/`: the `contextBridge` API exposed safely to renderer code.
- `src/renderer/src/`: React UI, PascalCase components, Zustand state, and OCR/STT/LLM services.
- `src/shared/`: types and preload API contracts shared across processes.
- `out/` and `release/`: generated build artifacts; do not edit them directly.

Keep IPC channels, preload exposure, and shared typings synchronized for cross-process features.

## Build, Test, and Development Commands

- `npm run dev:electron`: run the complete Electron application with hot reload.
- `npm run dev`: run only the Vite renderer server; Electron APIs are unavailable.
- `npm run typecheck`: type-check both Node/Electron and renderer projects.
- `npm run build:electron`: create production bundles under `out/`.
- `npm start`: preview the built Electron application.
- `npm run pack:mac`: preflight the fixed local signing identity, build and sign a macOS app, archive it as a verified ZIP, and remove the runnable staging copy.
- `npm run install:mac`: replace the app in `/Applications` from the verified ZIP, with rollback on failure.
- `npm run verify:mac-install`: verify the signature/version and assert that exactly one runnable copy exists by bundle ID.

Run `npm run typecheck && npm run build:electron` before submitting changes.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, single quotes, and no semicolons. Use `PascalCase` for React components and interfaces, `camelCase` for functions and variables, and `UPPER_SNAKE_CASE` for constants. Prefer the configured aliases (`@main`, `@renderer`, `@shared`) over long relative imports. Keep Tailwind utilities in JSX and reusable theme values in `tailwind.config.js`.

No formatter or linter is configured; keep diffs consistent with surrounding code and remove unused imports manually.

## Testing Guidelines

No automated test framework is configured. Treat type-checking and production builds as mandatory. Manually exercise changed Electron flows, especially global shortcuts, IPC, permissions, focus behavior, and packaging. Add future tests beside modules as `*.test.ts` or `*.test.tsx`.

## Commit & Pull Request Guidelines

Git history is unavailable in this checkout, so no established convention can be inferred. Use concise, imperative commits such as `fix(mentor): avoid stealing window focus`. Pull requests should explain behavior, list validation commands, link issues, and include UI screenshots or recordings. Document required macOS permissions or manual checks.

## Security & Configuration

Never commit API keys, credentials, or local proxy settings. Preserve `contextIsolation` and expose new privileged operations through typed preload APIs rather than enabling Node integration in renderer code.

### macOS Local Signing

- The local signing identity is `InviewPractice Build Signing` (SHA-1 `214D973EB2D105BAC731B3CD6426BC964ADA5BEC`) in the user's login keychain.
- A normal Codex sandbox can falsely report `0 valid identities found` and `CSSMERR_TP_NOT_TRUSTED` because it cannot access user trust settings. Do not infer that the certificate is missing, invalid, or lacks a private key from a sandbox-only result.
- Run `npm run pack:mac` with elevated execution after explaining that it only uses the code-signing identity and does not read password items. Never recreate, import, trust, or delete a certificate without explicit user authorization.
- Do not run `electron-builder --mac --dir` as the final packaging command. Its intermediate output is Electron ad-hoc signed; only `npm run pack:mac` produces the fixed designated requirement.
- `npm run pack:mac` checks identity visibility before building so a denied keychain boundary cannot overwrite the existing release with an unsigned/ad-hoc package.
- The durable release artifact is `release/Alfred-AI-<version>-mac-arm64.zip`. `release/mac-arm64/Alfred AI.app` is staging only and must be removed after the ZIP passes extraction and signature checks.

## 安装与调试

1. 每次改动后都需要重新打包程序为新版本安装包
2. 检测系统中已经安装的版本，并卸载
3. 安装最新的版本
4. 检查系统中是否只保留最新版本的App，如果不是则需要删除旧安装只保留最新的安装
5. 调试最新的安装版本，确保没有权限方面的问题。

“只保留最新版本”表示磁盘上只能存在一个 Bundle ID 为 `com.atlax.inview-practice` 的可运行 `.app`，其路径必须是 `/Applications/Alfred AI.app`。ZIP 安装包不计为可运行副本。不要仅检查 `/Applications`；必须执行 `npm run verify:mac-install`，同时检查用户目录、构建目录和 Spotlight 可见副本。
