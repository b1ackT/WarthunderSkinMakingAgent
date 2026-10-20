# Canvas commands

Run from the Skin Studio project directory, or use the absolute path to `agent.cjs`.

Every mutating command JSON has `revision` and `operation`. Use part and layer IDs from the latest `status.context`. Part key/name/output may also identify a target, but IDs are preferred.

## Independent background or material layer

```json
{
  "revision": 12,
  "operation": {
    "type": "fill",
    "name": "Base / graphite",
    "block": "background",
    "stage": 0,
    "targets": ["body", "turret"],
    "color": "#273847",
    "opacity": 0.65,
    "blend": "source-over",
    "prompt": "Cool graphite base, retain other independent layers"
  }
}
```

Normal image layers can contain generated texture art instead of solid fill. Supported blends: `source-over`, `multiply`, `screen`, `overlay`, `soft-light`, `lighter`.

## Cross-material image projection

```json
{
  "revision": 12,
  "operation": {
    "type": "image",
    "assetId": "ASSET_ID",
    "name": "Subject / independent source",
    "block": "character",
    "stage": 2,
    "prompt": "Exact generation or edit prompt",
    "placement": {
      "mode": "projection",
      "view": "left",
      "targets": ["body", "turret"],
      "rect": { "cx": 0.65, "cy": 0.48, "w": 0.25, "h": 0.4, "angle": 0 },
      "occlusion": true
    }
  }
}
```

`cx/cy` are image center coordinates in the projection view, top-left origin, normalized to 0–1. `w/h` are view fractions. Rotation is degrees. Use `view: current|left|right|front|top`, or use a saved `camera` and `viewport` from a user placement mark. Preserve the camera/viewport pair when adopting a marked rectangle. If `placement` is omitted, the asset's mark, then the job's mark, is used.

For flat UV placement: `"placement": { "mode":"uv", "targets":["body"], "rect":{"x":0.2,"y":0.3,"w":0.3,"h":0.4} }`.

## Change only an existing layer's source

```json
{
  "revision": 15,
  "operation": {
    "type": "image",
    "assetId": "NEW_ASSET_ID",
    "targetLayerId": "LAYER_ID_FROM_FEEDBACK",
    "block": "character",
    "prompt": "Change only the subject pose; keep the independent background intact"
  }
}
```

For a projection, this updates all associated material layers from the same source. The transform, mask, opacity and independent background layers remain. The source is retained in version history. Locked associated layers reject the update.

To refine the projector itself, include `placement` with `view` or `camera`, optional `viewport` and a revised `rect` in the targeted image command. It rebakes the same projection group with the new source and framing. Existing target materials stay linked. This is preferable to moving one material's UV layer independently.

## Transform or restyle a layer without regenerating

```json
{
  "revision": 15,
  "operation": {
    "type": "update",
    "layerIds": ["LAYER_ID"],
    "values": { "x": 0.3, "y": 0.25, "w": 0.3, "h": 0.4, "opacity": 0.8 },
    "prompt": "Move this UV image toward the upper armor panel"
  }
}
```

For projected source position changes, create a revised projection if a different projector is needed; do not use UV `x/y` to move a rebaked projection independently on one material. The user can use the editor's whole-projection controls to adjust it interactively.

## Text

```json
{
  "revision": 12,
  "operation": {
    "type": "text",
    "name": "Identification / separate text",
    "block": "text",
    "targets": ["turret"],
    "text": "HSTV / 01",
    "font": "Impact",
    "color": "#d8e7ed",
    "rect": { "x": 0.2, "y": 0.4, "w": 0.5, "h": 0.15 },
    "prompt": "Small independent identification text"
  }
}
```

Fonts: Arial, Microsoft YaHei, Georgia, Impact, Consolas. Text placement is in UV space; inspect the model and revise the region as needed. For cross-surface graphic typography, rasterize a separate text asset using appropriate deterministic rendering, then project that asset.

## Commands and responses

```text
node agent.cjs status
node agent.cjs claim
node agent.cjs event --file progress.json
node agent.cjs asset --path subject.png --role character --prompt "..."
node agent.cjs apply --file operation.json --wait
node agent.cjs preview --out preview.png
node agent.cjs stage --file stage.json
node agent.cjs complete --file complete.json
```

`stage.json`: `{ "revision": 12, "index": 0, "status": "completed", "message": "Style layers ready" }`.

`complete.json`: `{ "revision": 12, "message": "Layered draft ready for review" }`.

When the browser is closed, a result is stale, or a target is locked, the adapter returns an explicit error. Inspect `status` and resolve the actual issue; do not retry a rejected draw repeatedly or claim it succeeded.
