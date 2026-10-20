import * as THREE from 'three';

// Render the same 3D triangles in UV space, retaining their world positions.
// Per-triangle tile copies preserve UVs outside [0,1] without fract seam errors.
export function buildUVGeometry(model, parts) {
  model.updateMatrixWorld(true);
  const buffers = new Map(parts.map(p => [p.id, { position: [], atlas: [], faceNormal: [] }]));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  model.traverse(mesh => {
    if (!mesh.isMesh || !mesh.geometry.attributes.uv) return;
    const g = mesh.geometry, pos = g.attributes.position, uv = g.attributes.uv, idx = g.index;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: idx ? idx.count : pos.count, materialIndex: 0 }];
    for (const group of groups) {
      const part = mats[group.materialIndex]?.userData.part;
      if (!part || !buffers.has(part.id)) continue;
      const out = buffers.get(part.id);
      for (let i = group.start; i < group.start + group.count; i += 3) {
        const ids = [0, 1, 2].map(j => idx ? idx.getX(i + j) : i + j);
        a.fromBufferAttribute(pos, ids[0]).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(pos, ids[1]).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(pos, ids[2]).applyMatrix4(mesh.matrixWorld);
        n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
        const us = ids.map(k => uv.getX(k)), vs = ids.map(k => uv.getY(k));
        const minU = Math.floor(Math.min(...us) + 1e-6), maxU = Math.floor(Math.max(...us) - 1e-6);
        const minV = Math.floor(Math.min(...vs) + 1e-6), maxV = Math.floor(Math.max(...vs) - 1e-6);
        // Large intentional tiling still repeats; cap pathological input geometry.
        if ((maxU - minU + 1) * (maxV - minV + 1) > 64) continue;
        for (let tu = minU; tu <= Math.max(minU, maxU); tu++) {
          for (let tv = minV; tv <= Math.max(minV, maxV); tv++) {
            for (let j = 0; j < 3; j++) {
              const v = [a, b, c][j];
              out.position.push(v.x, v.y, v.z);
              out.faceNormal.push(n.x, n.y, n.z);
              out.atlas.push(us[j] - tu, vs[j] - tv);
            }
          }
        }
      }
    }
  });
  return new Map([...buffers].map(([id, b]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.position, 3));
    g.setAttribute('atlas', new THREE.Float32BufferAttribute(b.atlas, 2));
    g.setAttribute('faceNormal', new THREE.Float32BufferAttribute(b.faceNormal, 3));
    return [id, g];
  }));
}

const vertexShader = `
  attribute vec2 atlas;
  attribute vec3 faceNormal;
  varying vec3 worldPosition;
  varying vec3 surfaceNormal;
  void main() {
    worldPosition = position;
    surfaceNormal = faceNormal;
    gl_Position = vec4(atlas * 2.0 - 1.0, 0.0, 1.0);
  }
`;
const fragmentShader = `
  uniform sampler2D artwork;
  uniform sampler2D sceneDepth;
  uniform mat4 projector;
  uniform vec3 eye;
  uniform vec2 viewport;
  uniform vec4 rectangle;
  uniform float angle;
  uniform float nearPlane;
  uniform float farPlane;
  uniform float depthTolerance;
  uniform bool occlusion;
  uniform bool mirror;
  varying vec3 worldPosition;
  varying vec3 surfaceNormal;
  float distanceFromDepth(float z) {
    return 2.0 * nearPlane * farPlane /
      (farPlane + nearPlane - (z * 2.0 - 1.0) * (farPlane - nearPlane));
  }
  void main() {
    vec4 clip = projector * vec4(worldPosition, 1.0);
    if (clip.w <= 0.0) discard;
    vec3 ndc = clip.xyz / clip.w;
    vec2 screen = ndc.xy * 0.5 + 0.5;
    if (any(lessThan(screen, vec2(0.0))) || any(greaterThan(screen, vec2(1.0)))) discard;
    if (dot(normalize(surfaceNormal), normalize(eye - worldPosition)) < 0.06) discard;
    if (occlusion) {
      float front = texture2D(sceneDepth, screen).r;
      float behind = distanceFromDepth(ndc.z * 0.5 + 0.5);
      if (behind > distanceFromDepth(front) + depthTolerance) discard;
    }
    vec2 d = vec2(screen.x - rectangle.x, (1.0 - screen.y) - rectangle.y) * viewport;
    float co = cos(angle), si = sin(angle);
    vec2 q = vec2(co * d.x + si * d.y, -si * d.x + co * d.y);
    vec2 uv = vec2(q.x / (rectangle.z * viewport.x) + 0.5,
                   0.5 - q.y / (rectangle.w * viewport.y));
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard;
    if (mirror) uv.x = 1.0 - uv.x;
    vec4 color = texture2D(artwork, uv);
    if (color.a < 0.002) discard;
    gl_FragColor = color;
  }
`;

export async function bakeProjection({ renderer, model, geometries, parts, camera, image, rect, viewport, occlusion = true, mirror = false }) {
  camera.updateMatrixWorld(true);
  const previous = {
    target: renderer.getRenderTarget(), clear: renderer.getClearColor(new THREE.Color()),
    alpha: renderer.getClearAlpha(), tone: renderer.toneMapping, autoClear: renderer.autoClear,
  };
  const depth = new THREE.WebGLRenderTarget(2048, 2048, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  depth.depthTexture = new THREE.DepthTexture(2048, 2048, THREE.UnsignedIntType);
  const depthScene = new THREE.Scene(), depthClone = model.clone(true);
  depthClone.traverse(o => {
    if (o.isMesh) {
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      if (materials.every(m => m.transparent && m.opacity < 0.5)) o.visible = false;
    }
  });
  depthScene.add(depthClone);
  depthScene.overrideMaterial = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.NoColorSpace; // Bake byte values, not display lighting.
  texture.needsUpdate = true;
  const material = new THREE.ShaderMaterial({
    vertexShader, fragmentShader, side: THREE.DoubleSide,
    transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.NoBlending, toneMapped: false,
    uniforms: {
      artwork: { value: texture }, sceneDepth: { value: depth.depthTexture },
      projector: { value: new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse) },
      eye: { value: camera.position.clone() }, viewport: { value: new THREE.Vector2(viewport.width, viewport.height) },
      rectangle: { value: new THREE.Vector4(rect.cx, rect.cy, rect.w, rect.h) }, angle: { value: rect.angle * Math.PI / 180 },
      nearPlane: { value: camera.near }, farPlane: { value: camera.far }, depthTolerance: { value: 0.006 },
      occlusion: { value: occlusion }, mirror: { value: mirror },
    },
  });
  const bakeScene = new THREE.Scene(), bakeCamera = new THREE.Camera(), result = new Map();
  try {
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(depth);
    renderer.render(depthScene, camera);
    for (const part of parts) {
      const geometry = geometries.get(part.id);
      if (!geometry?.attributes.position.count) continue;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      bakeScene.add(mesh);
      const target = new THREE.WebGLRenderTarget(part.canvas.width, part.canvas.height, { depthBuffer: false, stencilBuffer: false });
      try {
        renderer.setRenderTarget(target);
        renderer.clear();
        renderer.render(bakeScene, bakeCamera);
        const w = target.width, h = target.height, pixels = new Uint8Array(w * h * 4);
        renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
        let count = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) count++;
        if (count) {
          const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
          const data = new Uint8ClampedArray(pixels.length);
          for (let y = 0; y < h; y++) data.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
          canvas.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
          result.set(part.id, { canvas, pixels: count });
        }
      } finally { target.dispose(); bakeScene.remove(mesh); }
    }
  } finally {
    renderer.setRenderTarget(previous.target);
    renderer.setClearColor(previous.clear, previous.alpha);
    renderer.toneMapping = previous.tone; renderer.autoClear = previous.autoClear;
    depth.dispose(); depth.depthTexture.dispose(); depthScene.overrideMaterial.dispose();
    material.dispose(); texture.dispose();
  }
  return result;
}

export function captureCamera(camera, target) {
  return { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), target: target.toArray(), fov: camera.fov, aspect: camera.aspect, near: camera.near, far: camera.far };
}
export function restoreCamera(data) {
  const camera = new THREE.PerspectiveCamera(data.fov, data.aspect, data.near, data.far);
  camera.position.fromArray(data.position); camera.quaternion.fromArray(data.quaternion);
  camera.updateMatrixWorld(true); return camera;
}

// Preserve the physical projector when the preview panel changes aspect ratio.
export function reframeRectangle(rect, oldAspect, newAspect) {
  const ratio = oldAspect / newAspect;
  return { ...rect, cx: .5 + (rect.cx - .5) * ratio, w: rect.w * ratio };
}
