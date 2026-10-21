import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const DEG = Math.PI / 180;

/* Generador pseudoaleatorio con semilla (mulberry32): mismo seed, mismo árbol. */
export function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnit(rng, target) {
  const u = rng() * 2 - 1;
  const theta = rng() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return target.set(s * Math.cos(theta), u, s * Math.sin(theta));
}

/*
 * Parámetros por especie. Los arrays se indexan por nivel de rama:
 * 0 = tronco, 1 = ramas principales, 2 = secundarias, etc.
 */
export const PRESETS = {
  broadleaf: {
    height: 9,
    trunkLength: 0.62,
    trunkRadius: 0.3,
    levels: 3,
    segments: [14, 8, 6, 4],
    radial: [16, 9, 6, 4],
    children: [7, 5, 4],
    childStart: [0.38, 0.22, 0.18],
    angle: [46, 42, 40],
    lengthRatio: [0.62, 0.58, 0.52],
    radiusRatio: [0.62, 0.62, 0.6],
    taper: [0.3, 0.25, 0.2, 0.15],
    gnarl: [0.05, 0.16, 0.22, 0.28],
    upForce: [0, 0.05, 0.03, 0.01],
    profile: (level, t) => (level === 0 ? 1 - 0.55 * t : 1 - 0.4 * t),
    leafLevels: [2, 3],
    leavesPerBranch: 11,
    leafStart: 0.3,
    leafSize: 0.8,
    leafUp: 0.2,
    leafTint: 0xf2fadf,
    leafTexture: 'broadleaf',
    barkColor: 0xc9b29a,
  },
  conifer: {
    height: 13,
    trunkLength: 1,
    trunkRadius: 0.26,
    levels: 2,
    segments: [22, 6, 3],
    radial: [14, 6, 4],
    children: [48, 4],
    childStart: [0.16, 0.25],
    angle: [84, 45],
    lengthRatio: [0.3, 0.42],
    radiusRatio: [0.32, 0.55],
    taper: [0.04, 0.25, 0.2],
    gnarl: [0.012, 0.07, 0.12],
    upForce: [0.01, -0.045, 0.0],
    profile: (level, t) => (level === 0 ? Math.pow(1 - t, 1.05) + 0.07 : 1 - 0.3 * t),
    leafLevels: [1, 2],
    leavesPerBranch: 7,
    leafStart: 0.15,
    leafSize: 0.9,
    leafUp: 0.05,
    leafTint: 0xe6f0dc,
    leafTexture: 'needles',
    barkColor: 0xb39a86,
  },
  // Naranjo: tronco corto, copa redonda y densa, hojas oscuras y frutas.
  orange: {
    height: 4.6,
    trunkLength: 0.36,
    trunkRadius: 0.17,
    levels: 3,
    segments: [8, 7, 5, 3],
    radial: [12, 8, 5, 4],
    children: [6, 5, 3],
    childStart: [0.6, 0.2, 0.25],
    angle: [58, 46, 42],
    lengthRatio: [1.55, 0.6, 0.5],
    radiusRatio: [0.7, 0.6, 0.6],
    taper: [0.6, 0.3, 0.25, 0.2],
    gnarl: [0.06, 0.2, 0.25, 0.3],
    upForce: [0, 0.03, 0.01, -0.01],
    profile: (level, t) => (level === 0 ? 1 - 0.3 * t : 1 - 0.3 * t),
    leafLevels: [2, 3],
    leavesPerBranch: 13,
    leafStart: 0.15,
    leafSize: 0.58,
    leafUp: 0.1,
    leafTint: 0xb5cba0,
    leafTexture: 'broadleaf',
    barkColor: 0xa89480,
    fruits: { chance: 0.07, radius: 0.12, color: 0xf08a1c },
  },
};

/* ---------- Texturas generadas en canvas ---------- */

const textureCache = new Map();

function canvasTexture(key, width, height, draw, { repeat = false } = {}) {
  if (textureCache.has(key)) return textureCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  textureCache.set(key, texture);
  return texture;
}

function barkTexture() {
  return canvasTexture('bark', 256, 512, (ctx, w, h) => {
    const rng = createRng(7);
    ctx.fillStyle = '#6f5845';
    ctx.fillRect(0, 0, w, h);

    // Cada trazo se dibuja desplazado en x/y para que la textura sea repetible.
    const strokeTiled = (fn) => {
      for (const dx of [-w, 0, w]) {
        for (const dy of [-h, 0, h]) {
          ctx.save();
          ctx.translate(dx, dy);
          fn();
          ctx.restore();
        }
      }
    };

    for (let i = 0; i < 520; i++) {
      const x = rng() * w;
      const y = rng() * h;
      const len = 30 + rng() * 140;
      const light = rng() > 0.5;
      const shade = light ? 120 + rng() * 60 : 40 + rng() * 40;
      ctx.strokeStyle = `rgba(${shade}, ${shade * 0.82}, ${shade * 0.66}, ${0.25 + rng() * 0.35})`;
      ctx.lineWidth = 1 + rng() * 3.5;
      strokeTiled(() => {
        ctx.beginPath();
        ctx.moveTo(x, y);
        let cx = x;
        for (let s = 1; s <= 6; s++) {
          cx += (rng() - 0.5) * 4;
          ctx.lineTo(cx, y + (len * s) / 6);
        }
        ctx.stroke();
      });
    }

    // Grietas profundas.
    for (let i = 0; i < 46; i++) {
      const x = rng() * w;
      const y = rng() * h;
      const len = 60 + rng() * 200;
      ctx.strokeStyle = `rgba(28, 20, 14, ${0.5 + rng() * 0.4})`;
      ctx.lineWidth = 1.5 + rng() * 3;
      strokeTiled(() => {
        ctx.beginPath();
        ctx.moveTo(x, y);
        let cx = x;
        for (let s = 1; s <= 10; s++) {
          cx += (rng() - 0.5) * 7;
          ctx.lineTo(cx, y + (len * s) / 10);
        }
        ctx.stroke();
      });
    }
  }, { repeat: true });
}

function drawLeafShape(ctx, length, width) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(width, -length * 0.22, width * 0.85, -length * 0.72, 0, -length);
  ctx.bezierCurveTo(-width * 0.85, -length * 0.72, -width, -length * 0.22, 0, 0);
  ctx.closePath();
}

function broadleafTexture() {
  return canvasTexture('leaf-broadleaf', 256, 256, (ctx, w, h) => {
    const rng = createRng(11);
    const palette = ['#5f8f3a', '#6e9d41', '#7fae4c', '#4f7f33', '#8bb555'];
    const twigBottom = h;
    const twigTop = 100;

    ctx.strokeStyle = '#5b4632';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(w / 2, twigBottom);
    ctx.quadraticCurveTo(w / 2 + 10, (twigBottom + twigTop) / 2, w / 2, twigTop);
    ctx.stroke();

    const leaves = [];
    const count = 8;
    for (let i = 0; i < count; i++) {
      const s = 0.15 + (i / count) * 0.8;
      const side = i % 2 === 0 ? 1 : -1;
      leaves.push({
        x: w / 2 + 6 * Math.sin(s * Math.PI),
        y: twigBottom - (twigBottom - twigTop) * s,
        angle: side * (38 + rng() * 22) * DEG,
        length: 58 + rng() * 22,
      });
    }
    leaves.push({ x: w / 2, y: twigTop, angle: (rng() - 0.5) * 10 * DEG, length: 72 });

    for (const leaf of leaves) {
      const width = leaf.length * (0.36 + rng() * 0.08);
      ctx.save();
      ctx.translate(leaf.x, leaf.y);
      ctx.rotate(leaf.angle);

      const base = palette[Math.floor(rng() * palette.length)];
      const gradient = ctx.createLinearGradient(0, 0, 0, -leaf.length);
      gradient.addColorStop(0, '#3f6a29');
      gradient.addColorStop(0.35, base);
      gradient.addColorStop(1, '#a4c766');
      drawLeafShape(ctx, leaf.length, width);
      ctx.fillStyle = gradient;
      ctx.fill();

      // Brillo lateral para dar volumen.
      ctx.save();
      ctx.clip();
      ctx.fillStyle = 'rgba(255, 255, 230, 0.12)';
      ctx.fillRect(0, -leaf.length, width, leaf.length);
      ctx.restore();

      // Nervaduras.
      ctx.strokeStyle = 'rgba(40, 60, 25, 0.55)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -leaf.length * 0.95);
      ctx.stroke();
      ctx.lineWidth = 0.8;
      for (let v = 1; v <= 4; v++) {
        const vy = -leaf.length * (v / 5.2);
        const vw = width * 0.6 * Math.sin((v / 5) * Math.PI);
        ctx.beginPath();
        ctx.moveTo(0, vy);
        ctx.lineTo(vw, vy - leaf.length * 0.1);
        ctx.moveTo(0, vy);
        ctx.lineTo(-vw, vy - leaf.length * 0.1);
        ctx.stroke();
      }
      ctx.restore();
    }
  });
}

function needlesTexture() {
  return canvasTexture('leaf-needles', 256, 256, (ctx, w, h) => {
    const rng = createRng(23);
    const palette = ['#2f5a2c', '#3c6b34', '#46783b', '#2a4f27', '#557f40'];
    ctx.lineCap = 'round';

    const drawTwig = (x0, y0, x1, y1, needleLen) => {
      ctx.strokeStyle = '#5a4430';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();

      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      const ux = dx / len;
      const uy = dy / len;
      const steps = Math.floor(len / 3);
      for (let i = 1; i < steps; i++) {
        const s = i / steps;
        const px = x0 + dx * s;
        const py = y0 + dy * s;
        const nl = needleLen * (1 - 0.45 * s) * (0.8 + rng() * 0.4);
        for (const side of [1, -1]) {
          const a = side * (50 + rng() * 15) * DEG;
          const nx = ux * Math.cos(a) - uy * Math.sin(a);
          const ny = ux * Math.sin(a) + uy * Math.cos(a);
          ctx.strokeStyle = palette[Math.floor(rng() * palette.length)];
          ctx.lineWidth = 1.6 + rng();
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px + nx * nl, py + ny * nl);
          ctx.stroke();
        }
      }
    };

    drawTwig(w / 2, h, w / 2, 40, 30);
    drawTwig(w / 2, h * 0.72, w * 0.22, h * 0.38, 20);
    drawTwig(w / 2, h * 0.72, w * 0.78, h * 0.38, 20);
    drawTwig(w / 2, h * 0.45, w * 0.3, h * 0.2, 16);
    drawTwig(w / 2, h * 0.45, w * 0.7, h * 0.2, 16);
  });
}

/* ---------- Viento (inyectado en los shaders de three.js) ---------- */

const WIND_GLSL = /* glsl */ `
uniform float uTime;
uniform float uWind;
uniform float uTreeHeight;
uniform float uPhase;
uniform float uFlutter;

vec3 windOffset(vec3 p) {
  float h = clamp(p.y / uTreeHeight, 0.0, 1.4);
  float bend = h * h;
  float t = uTime + uPhase;
  float gust = 0.75 + 0.25 * sin(t * 0.23);
  float sway = sin(t * 0.9) * 0.6 + sin(t * 1.7 + 1.3) * 0.3 + sin(t * 3.1 + p.y * 0.4) * 0.1;
  vec3 offset = vec3(1.0, 0.0, 0.35) * sway * bend * uWind * gust;
  float flutter = sin(uTime * 7.0 + dot(p, vec3(3.1, 2.3, 4.7))) * 0.04 * h * uFlutter;
  offset += vec3(flutter, flutter * 0.6, -flutter);
  return offset;
}
`;

const PROJECT_WITH_WIND = /* glsl */ `
vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition.xyz += windOffset(mvPosition.xyz);
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

/*
 * Normales de "copa": cada hoja usa una normal que apunta desde el centro de la copa
 * hacia afuera, así el follaje se ilumina como un volumen y no como planos sueltos.
 */
const LEAF_NORMAL = /* glsl */ `
#include <defaultnormal_vertex>
#ifdef USE_INSTANCING
  vec3 crownNormal = normalize(instanceMatrix[3].xyz - uCrownCenter);
  transformedNormal = normalize(mix(transformedNormal, normalMatrix * crownNormal, 0.7));
#endif
`;

export const NORMAL_NO_FLIP = /* glsl */ `
float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
vec3 normal = normalize(vNormal);
vec3 nonPerturbedNormal = normal;
`;

function applyWind(material, uniforms, { leaf = false } = {}) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_GLSL}\n${leaf ? 'uniform vec3 uCrownCenter;' : ''}`)
      .replace('#include <project_vertex>', PROJECT_WITH_WIND);
    if (leaf) {
      shader.vertexShader = shader.vertexShader.replace('#include <defaultnormal_vertex>', LEAF_NORMAL);
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', NORMAL_NO_FLIP);
    }
  };
  material.customProgramCacheKey = () => (leaf ? 'tree-wind-leaf' : 'tree-wind');
  return material;
}

/* ---------- Estructura de ramas ---------- */

class Branch {
  constructor(points, radii, level) {
    this.points = points;
    this.radii = radii;
    this.level = level;
  }

  #locate(t) {
    const f = THREE.MathUtils.clamp(t, 0, 1) * (this.points.length - 1);
    const i = Math.min(Math.floor(f), this.points.length - 2);
    return [i, f - i];
  }

  pointAt(t, target) {
    const [i, f] = this.#locate(t);
    return target.lerpVectors(this.points[i], this.points[i + 1], f);
  }

  tangentAt(t, target) {
    const [i] = this.#locate(t);
    return target.subVectors(this.points[i + 1], this.points[i]).normalize();
  }

  radiusAt(t) {
    const [i, f] = this.#locate(t);
    return THREE.MathUtils.lerp(this.radii[i], this.radii[i + 1], f);
  }
}

function perpendicular(v, target) {
  const helper = Math.abs(v.y) < 0.99 ? UP : AXIS_X;
  return target.crossVectors(helper, v).normalize();
}

function grow(ctx, start, dir, length, radius, level) {
  const { preset, rng } = ctx;
  const segments = Math.max(2, Math.round(preset.segments[level] * ctx.segmentScale));
  const points = [];
  const radii = [];
  const position = start.clone();
  const direction = dir.clone().normalize();
  const jitter = new THREE.Vector3();
  const segmentLength = length / segments;

  for (let i = 0; i <= segments; i++) {
    const s = i / segments;
    let r = radius * THREE.MathUtils.lerp(1, preset.taper[level], s);
    if (level === 0) r *= 1 + 0.6 * Math.exp(-s * 18);
    points.push(position.clone());
    radii.push(r);
    if (i === segments) break;

    direction.addScaledVector(randomUnit(rng, jitter), preset.gnarl[level]);
    direction.y += preset.upForce[level];
    direction.normalize();
    position.addScaledVector(direction, segmentLength);
  }

  const branch = new Branch(points, radii, level);
  ctx.branches.push(branch);

  if (level < preset.levels) spawnChildren(ctx, branch, length, level);
  if (preset.leafLevels.includes(level)) addLeaves(ctx, branch);
}

function spawnChildren(ctx, branch, length, level) {
  const { preset, rng } = ctx;
  const scale = level === 0 ? 1 : ctx.childScale;
  const count = Math.max(1, Math.round(preset.children[level] * scale));
  const start = preset.childStart[level];

  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const outward = new THREE.Vector3();
  const childDir = new THREE.Vector3();
  let azimuth = rng() * Math.PI * 2;

  for (let k = 0; k < count; k++) {
    const t = start + (1 - start) * ((k + 0.2 + rng() * 0.6) / count);
    branch.pointAt(t, point);
    branch.tangentAt(t, tangent);
    perpendicular(tangent, normal);
    binormal.crossVectors(tangent, normal);

    azimuth += GOLDEN_ANGLE + (rng() - 0.5) * 0.5;
    outward.copy(normal).multiplyScalar(Math.cos(azimuth)).addScaledVector(binormal, Math.sin(azimuth));

    const angle = preset.angle[level] * DEG * (0.8 + rng() * 0.4);
    childDir.copy(tangent).multiplyScalar(Math.cos(angle)).addScaledVector(outward, Math.sin(angle));

    const childLength = length * preset.lengthRatio[level] * preset.profile(level, t) * (0.85 + rng() * 0.3);
    const childRadius = branch.radiusAt(t) * preset.radiusRatio[level];
    grow(ctx, point, childDir, childLength, childRadius, level + 1);
  }
}

function addLeaves(ctx, branch) {
  const { preset, rng } = ctx;
  const count = Math.max(1, Math.round(preset.leavesPerBranch * ctx.leafScale));
  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const growth = new THREE.Vector3();
  const jitter = new THREE.Vector3();
  const align = new THREE.Quaternion();
  const spin = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();

  for (let k = 0; k < count; k++) {
    const t = k === 0 ? 1 : preset.leafStart + rng() * (1 - preset.leafStart);
    branch.pointAt(t, point);
    branch.tangentAt(t, tangent);

    growth.copy(tangent).multiplyScalar(0.7)
      .addScaledVector(randomUnit(rng, jitter), 0.8)
      .addScaledVector(UP, preset.leafUp)
      .normalize();
    align.setFromUnitVectors(UP, growth);
    spin.setFromAxisAngle(growth, rng() * Math.PI * 2);
    spin.multiply(align);

    const s = preset.leafSize * (0.7 + rng() * 0.6);
    scale.set(s, s, s);
    matrix.compose(point, spin, scale);
    ctx.leaves.push(matrix.clone());
  }
}

/* ---------- Construcción de la malla ---------- */

function buildBranchGeometry(branches, radialByLevel) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  const tangent = new THREE.Vector3();
  const prevTangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const q = new THREE.Quaternion();

  for (const branch of branches) {
    const { points, radii } = branch;
    const radial = radialByLevel[branch.level];
    const n = points.length;
    const base = positions.length / 3;
    const circumference = Math.max(2 * Math.PI * radii[0], 0.35);
    let arc = 0;

    for (let i = 0; i < n; i++) {
      const a = points[Math.max(i - 1, 0)];
      const b = points[Math.min(i + 1, n - 1)];
      tangent.subVectors(b, a).normalize();

      // Marcos de transporte paralelo: evitan que el tubo se retuerza.
      if (i === 0) {
        perpendicular(tangent, normal);
      } else {
        q.setFromUnitVectors(prevTangent, tangent);
        normal.applyQuaternion(q).normalize();
        arc += points[i].distanceTo(points[i - 1]);
      }
      binormal.crossVectors(tangent, normal);
      prevTangent.copy(tangent);

      for (let j = 0; j <= radial; j++) {
        const theta = (j / radial) * Math.PI * 2;
        dir.copy(normal).multiplyScalar(Math.cos(theta)).addScaledVector(binormal, Math.sin(theta));
        positions.push(
          points[i].x + dir.x * radii[i],
          points[i].y + dir.y * radii[i],
          points[i].z + dir.z * radii[i],
        );
        normals.push(dir.x, dir.y, dir.z);
        uvs.push(j / radial, (arc / circumference) * 0.5);
      }
    }

    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < radial; j++) {
        const a = base + i * (radial + 1) + j;
        const b = a + radial + 1;
        const c = b + 1;
        const d = a + 1;
        indices.push(a, d, b, d, c, b);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

let leafGeometry = null;
function getLeafGeometry() {
  if (!leafGeometry) {
    leafGeometry = new THREE.PlaneGeometry(1, 1);
    leafGeometry.translate(0, 0.5, 0);
  }
  return leafGeometry;
}

/* Oscurece las hojas interiores y bajas: una oclusión ambiental falsa pero efectiva. */
function leafColors(leaves, tint, rng) {
  const p = new THREE.Vector3();
  let maxR = 0.001;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const m of leaves) {
    p.setFromMatrixPosition(m);
    maxR = Math.max(maxR, Math.hypot(p.x, p.z));
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  const base = new THREE.Color(tint);
  const hsl = {};
  base.getHSL(hsl);
  const color = new THREE.Color();
  return leaves.map((m) => {
    p.setFromMatrixPosition(m);
    const exposure = THREE.MathUtils.clamp(
      0.55 * (Math.hypot(p.x, p.z) / maxR) + 0.45 * ((p.y - minY) / (maxY - minY || 1)),
      0,
      1,
    );
    const light = hsl.l * (0.55 + 0.45 * exposure) * (0.9 + rng() * 0.2);
    color.setHSL(hsl.h + (rng() - 0.5) * 0.05, THREE.MathUtils.clamp(hsl.s + (rng() - 0.5) * 0.2, 0, 1), light);
    return color.clone();
  });
}

let fruitGeometry = null;

/* Frutas en un subconjunto de las posiciones de hojas, corridas hacia afuera para que asomen. */
function createFruits(leafMatrices, crownCenter, { chance, radius, color }, rng, detail, uniforms) {
  const matrices = [];
  const position = new THREE.Vector3();
  const outward = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  for (const m of leafMatrices) {
    // Los árboles lejanos llevan menos frutas: casi no se distinguen y suman triángulos.
    if (rng() > chance * detail) continue;
    position.setFromMatrixPosition(m);
    outward.subVectors(position, crownCenter).setY(0).normalize();
    position.addScaledVector(outward, radius * 1.2);
    position.y -= radius;
    const s = radius * (0.85 + rng() * 0.3);
    scale.set(s, s * 0.95, s);
    matrices.push(matrix.compose(position, rotation, scale).clone());
  }

  fruitGeometry ??= new THREE.SphereGeometry(1, 9, 6);
  const material = applyWind(new THREE.MeshStandardMaterial({ roughness: 0.5 }), uniforms);
  const fruits = new THREE.InstancedMesh(fruitGeometry, material, matrices.length);
  const hsl = {};
  new THREE.Color(color).getHSL(hsl);
  const tint = new THREE.Color();
  matrices.forEach((m, i) => {
    fruits.setMatrixAt(i, m);
    // Algunas todavía verdosas.
    const hue = rng() < 0.08 ? 0.16 : hsl.h + (rng() - 0.5) * 0.025;
    tint.setHSL(hue, hsl.s, hsl.l * (0.9 + rng() * 0.2));
    fruits.setColorAt(i, tint);
  });
  fruits.instanceMatrix.needsUpdate = true;
  fruits.computeBoundingSphere();
  fruits.castShadow = true;
  fruits.receiveShadow = true;
  fruits.customDepthMaterial = applyWind(
    new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
    uniforms,
  );
  return fruits;
}

/**
 * Crea un árbol procedural.
 * @param {object} options
 * @param {'broadleaf'|'conifer'|'orange'} options.type Especie.
 * @param {number} options.seed Semilla: cada valor genera un árbol distinto.
 * @param {number} [options.detail=1] Entre 0 y 1; menos detalle para árboles lejanos.
 * @param {{uTime: {value:number}, uWind: {value:number}}} options.wind Uniforms compartidos de viento.
 */
export function createTree({ type = 'broadleaf', seed = 1, detail = 1, wind }) {
  const preset = PRESETS[type];
  const rng = createRng(seed);
  const height = preset.height * (0.85 + rng() * 0.3);
  const sizeFactor = height / preset.height;

  const ctx = {
    preset,
    rng,
    branches: [],
    leaves: [],
    segmentScale: detail < 1 ? 0.6 : 1,
    childScale: detail,
    leafScale: detail < 1 ? 0.85 : 1,
  };

  const trunkDir = new THREE.Vector3((rng() - 0.5) * 0.08, 1, (rng() - 0.5) * 0.08);
  grow(ctx, new THREE.Vector3(), trunkDir, height * preset.trunkLength, preset.trunkRadius * sizeFactor, 0);

  const radial = preset.radial.map((r) => Math.max(3, Math.round(r * (detail < 1 ? 0.6 : 1))));
  const branchGeometry = buildBranchGeometry(ctx.branches, radial);

  const branchUniforms = {
    uTime: wind.uTime,
    uWind: wind.uWind,
    uTreeHeight: { value: height },
    uPhase: { value: rng() * 10 },
    uFlutter: { value: 0.25 },
  };
  const crownCenter = new THREE.Vector3();
  const leafPosition = new THREE.Vector3();
  for (const m of ctx.leaves) crownCenter.add(leafPosition.setFromMatrixPosition(m));
  crownCenter.divideScalar(Math.max(ctx.leaves.length, 1));
  if (type === 'conifer') crownCenter.y *= 0.8;

  const leafUniforms = {
    ...branchUniforms,
    uFlutter: { value: 1 },
    uCrownCenter: { value: crownCenter },
  };

  const bark = barkTexture();
  const branchMaterial = applyWind(new THREE.MeshStandardMaterial({
    color: preset.barkColor,
    map: bark,
    bumpMap: bark,
    bumpScale: 2,
    roughness: 0.95,
  }), branchUniforms);

  const branches = new THREE.Mesh(branchGeometry, branchMaterial);
  branches.castShadow = true;
  branches.receiveShadow = true;
  branches.customDepthMaterial = applyWind(
    new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
    branchUniforms,
  );

  const leafTexture = preset.leafTexture === 'needles' ? needlesTexture() : broadleafTexture();
  const leafMaterial = applyWind(new THREE.MeshStandardMaterial({
    map: leafTexture,
    alphaTest: 0.45,
    side: THREE.DoubleSide,
    roughness: 0.75,
  }), leafUniforms, { leaf: true });

  const leaves = new THREE.InstancedMesh(getLeafGeometry(), leafMaterial, ctx.leaves.length);
  const colors = leafColors(ctx.leaves, preset.leafTint, rng);
  ctx.leaves.forEach((m, i) => {
    leaves.setMatrixAt(i, m);
    leaves.setColorAt(i, colors[i]);
  });
  leaves.instanceMatrix.needsUpdate = true;
  leaves.computeBoundingSphere();
  leaves.castShadow = true;
  leaves.receiveShadow = true;
  leaves.customDepthMaterial = applyWind(new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: leafTexture,
    alphaTest: 0.45,
  }), leafUniforms);

  const group = new THREE.Group();
  group.add(branches, leaves);
  if (preset.fruits) group.add(createFruits(ctx.leaves, crownCenter, preset.fruits, rng, detail, branchUniforms));
  group.userData.height = height;
  return group;
}
