# Distance-layer protocol (custom DDS mipmaps)

This creates an editable distance-dependent livery without changing model geometry. The writer exports a complete BGRA32 DDS mip chain down to 1×1. It does not add animation, model LODs, normal-map depth or a new shader to War Thunder.

## Configure

Read status and claim as usual. With the current revision:

```json
{"revision":31,"operation":{"type":"update","mipmap":{"enabled":true,"midLevel":3,"farLevel":6,"smooth":true}}}
```

`midLevel` is an integer 1–10; `farLevel` is an integer greater than `midLevel`, up to 14. At level 0 the near composite is used; at `midLevel` the mid composite; at/after `farLevel` the far composite. Adjacent variants blend progressively (smoothstep or linear). The GPU also filters between the exported mip levels. Small textures may not have enough levels to reach the far anchor: inspect part dimensions and choose useful anchors.

## Independent layer groups

New `image`, `fill`, `text` operations accept `distanceBand: "all|near|mid|far"`; absent means `all`. Use `all` for common base/material and shared markings. Each distance can have separate subjects and background. Never flatten a group's character and background together.

```json
{"revision":31,"operation":{"type":"image","assetId":"ID","name":"Far / character","block":"character","distanceBand":"far","placement":{"mode":"projection","view":"left","targets":["body","turret"],"rect":{"cx":0.4,"cy":0.59,"w":0.2,"h":0.18,"angle":-45}}}}
```

Change an existing group's distance with `{"type":"update","targetLayerId":"ID","values":{"distanceBand":"near"}}`. For a projection, every linked material layer changes together; locks on any sibling block the change. Targeted image edits preserve the band's placement and settings unless explicitly specified. `context` exposes the current bands and mip settings. Copying a projection to another distance in the UI creates a separate projector, preserving independent editing and the original group.

Existing projects without this field remain shared and distance mode is off. Disabling the mode shows/exports the near composition (shared + near), retaining mid/far layers in the project. Project save/restore preserves settings and all layers.

## Preview and export

The UI's “可变皮肤 · 远近渐变” panel offers near/mid/far buttons, a fractional-level manual preview, and automatic mip sampling as the model is zoomed/rotated. Manual mode compares composition at full working resolution; it is not a prediction of a fixed viewing distance. Automatic mode uses the exact integer mip chain used by export.

To switch the preview from the agent, use `{"revision":31,"operation":{"type":"preview","mipPreview":{"mode":"manual","level":3}}}`; mode can also be `auto`. Wait for `applied`, then fetch `agent.cjs preview`. This does not alter layers or increment the editor revision.

Before each generation and application, re-read status. Before completing a stage, inspect near, mid, far and an intermediate state. Ask the user to review if the current conversation cannot control the preview, and do not claim those views were checked. Export is independent of which preview is selected. The ZIP includes `distance-layers.json` describing settings/dimensions.

Mip selection depends on pixel coverage, angle, filtering, resolution and the game's texture handling. Do not promise a particular number of metres or that the game retains custom mips until tested there. Preserve an ordinary backup skin when making an experimental export.

Technical references: [Microsoft DDS header](https://learn.microsoft.com/en-us/windows/win32/direct3ddds/dds-header), [Microsoft image editor: editing individual MIP levels](https://github.com/MicrosoftDocs/visualstudio-docs/blob/main/docs/designers/image-editor.md).
