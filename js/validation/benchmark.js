/*
 * Validación de la medición contra un naranjo 3D con medidas conocidas.
 *
 * Una cámara virtual recorre el árbol a varias distancias y ángulos. En cada pose se hacen dos
 * renders de 640×480:
 *   1. El color, que pasa por segment(): el mismo modelo que la demo.
 *   2. Un pase de identificadores sin antialias, donde cada fruta se pinta con su índice y todo lo
 *      demás de negro. Dice cuántos píxeles de cada fruta quedan a la vista (hojas y otras frutas
 *      tapan) y evita emparejar instancias con frutas escondidas detrás.
 * Cada fruta visible se empareja con la instancia cuya caja contiene su centro proyectado (la de
 * centroide más cercano) y se compara la medición con la distancia y el tamaño reales.
 */
import * as THREE from 'three';
import { createTree } from '../scene/tree.js';
import { loadModel, segment, MODEL_INFO } from '../demo/segmenter.js';
import { apparentRadius, distanceToCenter, focalFromFov, sizeAtDistance, volumeAgro } from '../demo/geometry.js';

const WIDTH = 640;
const HEIGHT = 480;
const VFOV_DEG = 50;
const TREE_SEED = 7;
// El diámetro medio de las frutas de la escena equivale a una naranja de 75 mm.
const ORANGE_MM = 75;
// Frutas con menos píxeles a la vista (en 640×480) no se evalúan: son casi invisibles.
const MIN_VISIBLE_PX = 40;
// "Sin oclusión": al menos esta fracción de la silueta a la vista.
const UNOCCLUDED = 0.8;
// Si el modelo detecta menos que esto con las esferas de la demo, se repite con esferas finas.
const LOW_DETECTION = 0.3;
const BIN_CM = 25;
const SUN_DIRECTION = new THREE.Vector3(25, 35, 18).normalize();
const MASK_COLOR = [255, 84, 0, 140];

// Focal exacta de la cámara virtual, normalizada por el ancho de la imagen.
const EXACT_FOCAL_RATIO = HEIGHT / 2 / Math.tan((VFOV_DEG * Math.PI) / 360) / WIDTH;

const notice = document.getElementById('bench-notice');
const status = document.getElementById('bench-status');
const runButton = document.getElementById('bench-run');
const csvButton = document.getElementById('bench-csv');
const distancesInput = document.getElementById('bench-distances');
const anglesInput = document.getElementById('bench-angles');
const fovInput = document.getElementById('bench-fov');
const fineInput = document.getElementById('bench-fine');
const table = document.getElementById('bench-table');
const preview = document.getElementById('bench-preview');
const previewCtx = preview.getContext('2d');

/* ---------- Escena ---------- */

/* El viento se inyecta en los shaders y no queda en las matrices: se quita para medir lo dibujado. */
function stripWind(root) {
  root.traverse((obj) => {
    for (const material of [obj.material, obj.customDepthMaterial]) {
      if (!material) continue;
      delete material.onBeforeCompile;
      delete material.customProgramCacheKey;
      material.needsUpdate = true;
    }
  });
}

function createBench() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const sky = new THREE.Color(0xc4dbea);
  scene.background = sky;

  // Misma luz que el naranjal de la portada.
  scene.add(new THREE.HemisphereLight(0xdcefff, 0x5a4a32, 1.4));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.8);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 80 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x7f9d4f, roughness: 1 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  const tree = createTree({ type: 'orange', seed: TREE_SEED, detail: 1, wind: { uTime: { value: 0 }, uWind: { value: 0 } } });
  stripWind(tree);
  scene.add(tree);
  scene.updateMatrixWorld(true);

  const fruits = tree.getObjectByName('fruits');
  const leaves = tree.children.find((o) => o.isInstancedMesh && o !== fruits);
  const branches = tree.children.find((o) => o.isMesh && !o.isInstancedMesh);

  // Medidas reales. Las frutas son elipsoides (x, 0,95·y, z): de costado se ven como un círculo
  // de radio √(sx·sy).
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const truth = [];
  for (let i = 0; i < fruits.count; i++) {
    fruits.getMatrixAt(i, matrix);
    matrix.premultiply(fruits.matrixWorld);
    const center = new THREE.Vector3();
    matrix.decompose(center, quaternion, scale);
    truth.push({
      center,
      radius: Math.sqrt(scale.x * scale.y),
      volume: (4 / 3) * Math.PI * scale.x * scale.y * scale.z,
    });
  }
  const meanDiameter = truth.reduce((sum, t) => sum + 2 * t.radius, 0) / truth.length;
  const mmPerUnit = ORANGE_MM / meanDiameter;

  const crownCenter = truth.reduce((sum, t) => sum.add(t.center), new THREE.Vector3()).divideScalar(truth.length);
  const crownRadius = Math.max(...truth.map((t) => Math.hypot(t.center.x - crownCenter.x, t.center.z - crownCenter.z)));
  sun.position.add(crownCenter);
  sun.target.position.copy(crownCenter);

  // Pase de identificadores: fruta i con color (i + 1) en rojo/verde y azul 255; lo demás, negro.
  const idTarget = new THREE.WebGLRenderTarget(WIDTH, HEIGHT);
  const idColors = new THREE.InstancedBufferAttribute(new Float32Array(fruits.count * 3), 3);
  for (let i = 0; i < fruits.count; i++) {
    const id = i + 1;
    idColors.setXYZ(i, (id & 255) / 255, ((id >> 8) & 255) / 255, 1);
  }
  const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const idMaterials = new Map([
    [ground, black],
    [branches, black],
    [leaves, new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: leaves.material.map,
      alphaTest: leaves.material.alphaTest,
      side: THREE.DoubleSide,
    })],
    [fruits, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })],
  ]);
  const idPixels = new Uint8Array(WIDTH * HEIGHT * 4);

  const camera = new THREE.PerspectiveCamera(VFOV_DEG, WIDTH / HEIGHT, 0.05, 200);
  const coarseGeometry = fruits.geometry;
  const fineGeometry = new THREE.SphereGeometry(1, 32, 16);

  /* Cantidad de píxeles a la vista de cada fruta (índice i en counts[i + 1]). */
  function renderIds() {
    const saved = new Map([...idMaterials.keys()].map((mesh) => [mesh, mesh.material]));
    const savedColors = fruits.instanceColor;
    for (const [mesh, material] of idMaterials) mesh.material = material;
    fruits.instanceColor = idColors;
    scene.background = null;

    renderer.setRenderTarget(idTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(idTarget, 0, 0, WIDTH, HEIGHT, idPixels);
    renderer.setRenderTarget(null);

    for (const [mesh, material] of saved) mesh.material = material;
    fruits.instanceColor = savedColors;
    scene.background = sky;

    const counts = new Int32Array(fruits.count + 1);
    for (let p = 0; p < idPixels.length; p += 4) {
      if (idPixels[p + 2] === 255) counts[idPixels[p] + idPixels[p + 1] * 256]++;
    }
    return counts;
  }

  function renderColor() {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    return renderer.domElement;
  }

  function setFine(fine) {
    fruits.geometry = fine ? fineGeometry : coarseGeometry;
  }

  return { camera, truth, mmPerUnit, crownCenter, crownRadius, renderIds, renderColor, setFine };
}

/* ---------- Geometría de la cámara virtual ---------- */

const cameraSpace = new THREE.Vector3();
const corner = new THREE.Vector3();

/* Píxeles (en 640×480) de la silueta de una esfera sin oclusión, también fuera del eje óptico. */
function projectedArea(center, radius, camera) {
  cameraSpace.copy(center).applyMatrix4(camera.matrixWorldInverse);
  const depth = -cameraSpace.z;
  const distance = cameraSpace.length();
  const sin = radius / distance;
  const cosAxis = depth / distance;
  const denominator = cosAxis ** 2 - sin ** 2;
  if (depth <= 0 || denominator <= 0) return Infinity;
  const f = EXACT_FOCAL_RATIO * WIDTH;
  return (Math.PI * f * f * sin * sin * Math.sqrt(1 - sin * sin)) / denominator ** 1.5;
}

/* ¿Entra la esfera entera en el cuadro? Se proyectan las esquinas de su cubo envolvente. */
function insideFrame(center, radius, camera) {
  cameraSpace.copy(center).applyMatrix4(camera.matrixWorldInverse);
  if (-cameraSpace.z - radius <= camera.near) return false;
  for (let i = 0; i < 8; i++) {
    corner.set(
      cameraSpace.x + (i & 1 ? radius : -radius),
      cameraSpace.y + (i & 2 ? radius : -radius),
      cameraSpace.z + (i & 4 ? radius : -radius),
    ).applyMatrix4(camera.projectionMatrix);
    if (Math.abs(corner.x) > 1 || Math.abs(corner.y) > 1) return false;
  }
  return true;
}

/* ---------- Barrido ---------- */

function parseDistances(text) {
  return text.split(/[;\s]+|,\s+/)
    .map((part) => Number(part.replace(',', '.')))
    .filter((value) => Number.isFinite(value) && value > 0);
}

/* Empareja frutas visibles con instancias: centro proyectado dentro de la caja, centroide más cercano. */
function match(candidates, instances, maskWidth, maskHeight) {
  const pairs = [];
  candidates.forEach((fruit, f) => {
    const u = (fruit.px / WIDTH) * maskWidth - 0.5;
    const v = (fruit.py / HEIGHT) * maskHeight - 0.5;
    instances.forEach((inst, i) => {
      if (u < inst.minU - 1 || u > inst.maxU + 1 || v < inst.minV - 1 || v > inst.maxV + 1) return;
      pairs.push({ f, i, cost: Math.hypot(u - inst.cx, v - inst.cy) });
    });
  });
  pairs.sort((a, b) => a.cost - b.cost);
  const usedFruit = new Set();
  const usedInstance = new Set();
  const result = new Map();
  for (const { f, i } of pairs) {
    if (usedFruit.has(f) || usedInstance.has(i)) continue;
    usedFruit.add(f);
    usedInstance.add(i);
    result.set(f, instances[i]);
  }
  return result;
}

function drawPreview(frame, segmentation, points) {
  previewCtx.drawImage(frame, 0, 0, WIDTH, HEIGHT);
  const { mask, width, height } = segmentation;
  const overlay = new ImageData(width, height);
  for (let p = 0; p < mask.length; p++) if (mask[p]) overlay.data.set(MASK_COLOR, p * 4);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(overlay, 0, 0);
  previewCtx.drawImage(canvas, 0, 0, WIDTH, HEIGHT);
  for (const { px, py, valid } of points) {
    previewCtx.beginPath();
    previewCtx.arc(px, py, 4, 0, Math.PI * 2);
    previewCtx.fillStyle = valid ? '#3fbf5f' : '#d23b2b';
    previewCtx.fill();
    previewCtx.strokeStyle = '#ffffff';
    previewCtx.stroke();
  }
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

async function runSweep(bench, { distances, angles, fovDeg, fine }) {
  bench.setFine(fine);
  const { camera, truth, mmPerUnit, crownCenter, crownRadius } = bench;
  const work = document.createElement('canvas');
  const workCtx = work.getContext('2d', { willReadFrequently: true });
  const inputScale = MODEL_INFO.inputSize / Math.max(WIDTH, HEIGHT);
  work.width = Math.round(WIDTH * inputScale);
  work.height = Math.round(HEIGHT * inputScale);

  const rows = [];
  const total = distances.length * angles;
  let pose = 0;
  for (let a = 0; a < angles; a++) {
    // Medio paso de desfase para no mirar justo de frente al sol en la primera pose.
    const theta = ((a + 0.5) / angles) * Math.PI * 2;
    for (const distance of distances) {
      pose++;
      const radius = crownRadius + distance;
      camera.position.set(
        crownCenter.x + Math.cos(theta) * radius,
        crownCenter.y,
        crownCenter.z + Math.sin(theta) * radius,
      );
      camera.lookAt(crownCenter);
      camera.updateMatrixWorld();

      const counts = bench.renderIds();
      const frame = bench.renderColor();
      workCtx.drawImage(frame, 0, 0, work.width, work.height);
      const segmentation = await segment(workCtx.getImageData(0, 0, work.width, work.height));
      const maskFocal = EXACT_FOCAL_RATIO * segmentation.width;
      const fovFocal = focalFromFov(segmentation.width, fovDeg);

      // Frutas con algo a la vista: compiten por las instancias aunque estén cortadas por el borde.
      const candidates = [];
      truth.forEach((t, index) => {
        const visible = counts[index + 1];
        if (visible < MIN_VISIBLE_PX) return;
        const ndc = t.center.clone().project(camera);
        candidates.push({
          index,
          t,
          visible,
          px: ((ndc.x + 1) / 2) * WIDTH,
          py: ((1 - ndc.y) / 2) * HEIGHT,
          whole: insideFrame(t.center, t.radius, camera),
        });
      });
      const matches = match(candidates, segmentation.instances, segmentation.width, segmentation.height);

      const points = [];
      candidates.forEach((c, f) => {
        if (!c.whole) return; // cortada por el borde del cuadro: no se evalúa
        const zTrue = c.t.center.distanceTo(camera.position) * mmPerUnit;
        const instance = matches.get(f);
        const valid = Boolean(instance) && !instance.touchesEdge;
        const row = {
          pose,
          angleDeg: Math.round((theta * 180) / Math.PI),
          cameraDistance: distance,
          fruit: c.index,
          visibility: Math.min(1, c.visible / projectedArea(c.t.center, c.t.radius, camera)),
          detected: Boolean(instance),
          valid,
          zTrueCm: zTrue / 10,
          dTrueMm: 2 * c.t.radius * mmPerUnit,
          vTrueMl: (c.t.volume * mmPerUnit ** 3) / 1000,
        };
        if (valid) {
          const r = apparentRadius(instance);
          row.radiusPx = r;
          row.zExactCm = distanceToCenter(r, maskFocal, ORANGE_MM) / 10;
          row.zFovCm = distanceToCenter(r, fovFocal, ORANGE_MM) / 10;
          row.dEstMm = sizeAtDistance(r, maskFocal, zTrue);
          row.vEstMl = volumeAgro(instance.hullArea, maskFocal, zTrue);
        }
        rows.push(row);
        points.push({ px: c.px, py: c.py, valid });
      });

      drawPreview(frame, segmentation, points);
      status.textContent = `Captura ${pose} de ${total} · ${rows.length} frutas evaluadas, ${rows.filter((r) => r.valid).length} válidas.`;
      await nextFrame();
    }
  }
  return rows;
}

/* ---------- Métricas ---------- */

const QUANTITIES = [
  { key: 'zExactCm', truth: 'zTrueCm', title: 'Distancia, f exacta', unit: 'cm' },
  { key: 'zFovCm', truth: 'zTrueCm', title: 'Distancia, FOV supuesto', unit: 'cm' },
  { key: 'dEstMm', truth: 'dTrueMm', title: 'Diámetro', unit: 'mm' },
  { key: 'vEstMl', truth: 'vTrueMl', title: 'Volumen', unit: 'mL' },
];

function errorStats(rows, key, truth) {
  const valid = rows.filter((r) => r.valid);
  if (valid.length === 0) return null;
  let abs = 0;
  let squared = 0;
  let percent = 0;
  for (const r of valid) {
    const e = r[key] - r[truth];
    abs += Math.abs(e);
    squared += e * e;
    percent += Math.abs(e) / r[truth];
  }
  return { mae: abs / valid.length, rmse: Math.sqrt(squared / valid.length), mape: (100 * percent) / valid.length };
}

const fmt = (value, digits = 1) => (value === null || value === undefined || !Number.isFinite(value)
  ? '—'
  : value.toLocaleString('es-AR', { minimumFractionDigits: digits, maximumFractionDigits: digits }));

function renderTable(rows, caption) {
  const groups = new Map();
  for (const row of rows) {
    const bin = Math.floor(row.zTrueCm / BIN_CM) * BIN_CM;
    if (!groups.has(bin)) groups.set(bin, []);
    groups.get(bin).push(row);
  }
  const lines = [...groups.keys()].sort((a, b) => a - b)
    .map((bin) => ({ label: `${bin}–${bin + BIN_CM} cm`, rows: groups.get(bin) }));
  lines.push({ label: 'Total', rows, total: true });
  lines.push({ label: `Sin oclusión (≥ ${UNOCCLUDED * 100} %)`, rows: rows.filter((r) => r.visibility >= UNOCCLUDED), total: true });

  const head = `
    <caption>${caption}</caption>
    <thead>
      <tr>
        <th rowspan="2">Distancia real</th><th rowspan="2">Frutas</th><th rowspan="2">Válidas</th>
        ${QUANTITIES.map((q) => `<th colspan="3">${q.title}</th>`).join('')}
      </tr>
      <tr>${QUANTITIES.map((q) => `<th>MAE (${q.unit})</th><th>RMSE (${q.unit})</th><th>Error %</th>`).join('')}</tr>
    </thead>`;
  const body = lines.map(({ label, rows: subset, total }) => {
    const valid = subset.filter((r) => r.valid).length;
    const cells = QUANTITIES.map((q) => {
      const s = errorStats(subset, q.key, q.truth);
      return `<td>${fmt(s?.mae)}</td><td>${fmt(s?.rmse)}</td><td>${fmt(s?.mape)}</td>`;
    }).join('');
    const rate = subset.length ? `${fmt((100 * valid) / subset.length, 0)} %` : '—';
    return `<tr${total ? ' class="is-total"' : ''}><td>${label}</td><td>${subset.length}</td><td>${rate}</td>${cells}</tr>`;
  }).join('');
  table.innerHTML = `${head}<tbody>${body}</tbody>`;
  table.hidden = false;
}

const CSV_COLUMNS = [
  'pose', 'angleDeg', 'cameraDistance', 'fruit', 'visibility', 'detected', 'valid', 'radiusPx',
  'zTrueCm', 'zExactCm', 'zFovCm', 'dTrueMm', 'dEstMm', 'vTrueMl', 'vEstMl',
];

function toCsv(rows) {
  const value = (v) => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : v === undefined ? '' : String(v));
  return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => value(r[c])).join(','))].join('\n');
}

/* ---------- Página ---------- */

let bench = null;
let lastRows = null;

function showNotice(extra = '') {
  const title = document.createElement('strong');
  let text;
  if (MODEL_INFO.status === 'loading') {
    title.textContent = 'Cargando modelo…';
    text = '';
  } else if (MODEL_INFO.simulated) {
    title.textContent = 'Máscara simulada:';
    text = ' no se encontró el modelo en model/, se mide con la segmentación por color.';
  } else {
    title.textContent = `Modelo: ${MODEL_INFO.name}`;
    text = ` (${MODEL_INFO.backend === 'webgpu' ? 'WebGPU' : 'WASM'}).`;
  }
  notice.replaceChildren(title, text + extra);
  notice.classList.toggle('is-simulated', MODEL_INFO.simulated && MODEL_INFO.status === 'ready');
}

async function run() {
  const distances = parseDistances(distancesInput.value);
  const angles = Math.max(1, Math.min(36, Math.round(Number(anglesInput.value)) || 8));
  const fovDeg = Number(String(fovInput.value).replace(',', '.'));
  if (distances.length === 0 || !(fovDeg > 0 && fovDeg < 180)) {
    status.textContent = 'Revisá las distancias y el campo de visión.';
    return;
  }

  runButton.disabled = true;
  csvButton.disabled = true;
  try {
    await loadModel();
    showNotice();
    bench ??= createBench();

    let fine = fineInput.checked;
    let rows = await runSweep(bench, { distances, angles, fovDeg, fine });
    const detected = rows.filter((r) => r.detected).length;
    if (!fine && rows.length > 0 && detected / rows.length < LOW_DETECTION) {
      // Las esferas de 9×6 de la demo tienen pocos polígonos: el modelo puede no reconocerlas.
      fine = true;
      fineInput.checked = true;
      showNotice(` Con las esferas de la demo detectó solo el ${Math.round((100 * detected) / rows.length)} % ` +
        'de las frutas: se repitió el barrido con esferas finas (32×16).');
      rows = await runSweep(bench, { distances, angles, fovDeg, fine });
    }

    lastRows = rows;
    const hfovExact = Math.round((360 / Math.PI) * Math.atan(0.5 / EXACT_FOCAL_RATIO));
    renderTable(rows, `${rows.length} frutas en ${distances.length * angles} capturas · ` +
      `esferas ${fine ? 'finas (32×16)' : 'de la demo (9×6)'} · FOV real ${hfovExact}°, supuesto ${fovDeg}° · ` +
      `diámetro supuesto ${ORANGE_MM} mm, real entre ${fmt(0.85 * ORANGE_MM, 0)} y ${fmt(1.15 * ORANGE_MM, 0)} mm aprox.`);
    csvButton.disabled = rows.length === 0;
    status.textContent = `Listo: ${rows.filter((r) => r.valid).length} de ${rows.length} frutas medidas.`;
  } catch (error) {
    console.error(error);
    status.textContent = `Falló el barrido: ${error?.message ?? error}`;
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener('click', run);

csvButton.addEventListener('click', () => {
  if (!lastRows) return;
  const url = URL.createObjectURL(new Blob([toCsv(lastRows)], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'validacion_medicion.csv';
  link.click();
  URL.revokeObjectURL(url);
});

loadModel().then(() => showNotice());
showNotice();
