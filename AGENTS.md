# Skin Studio integration

For skin-creation tasks submitted through this workspace, read `skills/wt-skin-agent/SKILL.md` and use `agent.cjs` to read live user input and publish layer operations. This is a current-conversation workflow; do not start another Codex session.

For ordinary software maintenance, edit and test the app normally. The skin workflow does not apply to unrelated code changes. Existing `skin-editor` and original user assets are separate from this project and should be preserved.

## GitHub publishing boundary (user preference)

Upload only program source, tests and necessary documentation. Keep the user's reference images, generated artwork, skin exports, editable projects, previews, prompts and live task/editor state local. Never force-add ignored personal files. In particular, `.studio-agent/`, `output/`, generated `tests/artifacts/` and session backups must not be tracked or pushed. Stage explicit program paths instead of using broad `git add .` or `git add -A`. Preserve local files when removing accidental tracking. Do not rewrite published history without an explicit request.
