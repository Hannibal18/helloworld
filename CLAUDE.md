# helloworld

A browser game project (Vite + TypeScript) with custom sprite assets.

## Pixel Art / Sprite Work

When creating or editing pixel art and sprite sheets through the Aseprite MCP Pro server (`aseprite-mcp-pro`), follow the skill guide at:

`/Users/han/Developer/mcp-servers/aseprite-mcp-pro/skills.md`

It covers canvas proportions, palette strategy, layer order, animation timing, and batching pixel operations with `execute_script` instead of looping `put_pixel`. Read it before starting any sprite task.

## Project notes

- Game source lives under `src/`
- Existing sprite assets in the project root and `public/` — check there before generating new ones to keep style consistent
- `game_helloworld.md` has game-design notes — consult it for character/world context before creating new sprites
