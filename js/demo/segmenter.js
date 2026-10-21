/*
 * Interfaz del modelo de segmentación de naranjas.
 *
 * Contrato que usa demo.js:
 *   - entrada:  ImageData (RGBA) del frame o de la imagen subida, con el lado mayor
 *               igual a MODEL_INFO.inputSize.
 *   - salida:   { mask, width, height, coverage, count }
 *       mask      Uint8Array de width * height con 1 = naranja, 0 = fondo. Puede tener
 *                 menos resolución que la entrada: se dibuja escalada sobre la imagen.
 *       coverage  fracción de píxeles marcados como naranja (0 a 1).
 *       count     cantidad de naranjas detectadas.
 *
 * Si existen model/model.json y model/orange-seg.onnx (los genera naranjas.ipynb), se usa
 * YOLO26n-seg con ONNX Runtime Web. Si no, la máscara se simula detectando los píxeles de
 * color naranja, así la página funciona igual antes de exportar el modelo.
 */

const MODEL_DIR = 'model/';

export const MODEL_INFO = {
  name: 'Cargando modelo…',
  status: 'loading', // 'loading' | 'ready'
  simulated: true,
  reason: '',
  inputSize: 256,
};

/* ---------- Simulación por color ---------- */

const SIM_SIZE = 256;
// Rango de tono de la naranja (en grados) y mínimos de saturación y brillo en HSV.
const HUE_MIN = 12;
const HUE_MAX = 42;
const SAT_MIN = 0.55;
const VAL_MIN = 0.35;
// Manchas más chicas que esta fracción de la imagen no cuentan como naranja.
const MIN_BLOB = 0.002;

function segmentByColor(imageData) {
  const { data, width, height } = imageData;
  const raw = new Uint8Array(width * height);

  for (let i = 0, p = 0; p < raw.length; i += 4, p++) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    // En los naranjas el rojo es el canal máximo: el tono sale de (g - b) / delta.
    if (max !== r || max < VAL_MIN || delta / max < SAT_MIN) continue;
    const hue = (60 * (g - b)) / delta;
    raw[p] = hue >= HUE_MIN && hue <= HUE_MAX ? 1 : 0;
  }

  const mask = majorityFilter(raw, width, height);
  const count = removeSmallBlobs(mask, width, height, Math.max(12, MIN_BLOB * mask.length));
  return result(mask, width, height, count);
}

/* Filtro de mayoría 3x3: elimina píxeles sueltos y suaviza bordes. */
function majorityFilter(src, width, height) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let votes = 0;
      let total = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          votes += src[yy * width + xx];
          total++;
        }
      }
      out[y * width + x] = votes * 2 > total ? 1 : 0;
    }
  }
  return out;
}

/* Borra las manchas chicas (componentes conexas) y devuelve cuántas quedaron. */
function removeSmallBlobs(mask, width, height, minArea) {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const blob = [];
  let count = 0;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    blob.length = 0;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const p = stack[--top];
      blob.push(p);
      const x = p % width;
      const neighbors = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        p >= width ? p - width : -1,
        p < mask.length - width ? p + width : -1,
      ];
      for (const q of neighbors) {
        if (q >= 0 && mask[q] && !seen[q]) {
          seen[q] = 1;
          stack[top++] = q;
        }
      }
    }
    if (blob.length >= minArea) count++;
    else for (const p of blob) mask[p] = 0;
  }
  return count;
}

/* ---------- Modelo real: YOLO26n-seg con ONNX Runtime Web ---------- */

// Lado mayor de la máscara devuelta: los prototipos del modelo son de 160x160, más no aporta.
const MASK_SIZE = 320;
// Solo para salidas crudas sin NMS ([1, 4 + clases + 32, anclas]).
const NMS_IOU = 0.7;
const LETTERBOX_GRAY = 'rgb(114, 114, 114)';

let ort = null;
let session = null;
let config = null;
let letterbox = null;
let source = null;

async function loadOnnx() {
  const response = await fetch(`${MODEL_DIR}model.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`no se encontró ${MODEL_DIR}model.json`);
  config = await response.json();
  ort = await import('onnxruntime-web');
  session = await ort.InferenceSession.create(`${MODEL_DIR}${config.file ?? 'orange-seg.onnx'}`, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });

  const size = config.imgsz;
  letterbox = document.createElement('canvas');
  letterbox.width = letterbox.height = size;
  source = document.createElement('canvas');

  Object.assign(MODEL_INFO, {
    name: config.name ?? 'YOLO26n-seg',
    simulated: false,
    inputSize: size,
  });
}

/* Ajusta la imagen dentro de un cuadrado de imgsz con bordes grises, como Ultralytics. */
function toTensor(imageData) {
  const size = config.imgsz;
  const { width, height } = imageData;
  const scale = Math.min(size / width, size / height);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const padX = Math.round((size - w) / 2 - 0.1);
  const padY = Math.round((size - h) / 2 - 0.1);

  source.width = width;
  source.height = height;
  source.getContext('2d').putImageData(imageData, 0, 0);
  const ctx = letterbox.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = LETTERBOX_GRAY;
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(source, padX, padY, w, h);
  const rgba = ctx.getImageData(0, 0, size, size).data;

  // RGBA intercalado -> 3 planos RGB (NCHW) normalizados a 0..1.
  const area = size * size;
  const chw = new Float32Array(3 * area);
  for (let p = 0, i = 0; p < area; p++, i += 4) {
    chw[p] = rgba[i] / 255;
    chw[p + area] = rgba[i + 1] / 255;
    chw[p + 2 * area] = rgba[i + 2] / 255;
  }
  return {
    tensor: new ort.Tensor('float32', chw, [1, 3, size, size]),
    transform: { scale, padX, padY },
  };
}

/* Salida [1, N, 6 + nm]: x1, y1, x2, y2, confianza, clase, coeficientes (exportado con o sin NMS). */
function parseDetections(output, nm, conf) {
  const [, n, stride] = output.dims;
  const d = output.data;
  const boxes = [];
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    if (d[o + 4] < conf || Math.round(d[o + 5]) !== config.classId) continue;
    boxes.push({
      x1: d[o], y1: d[o + 1], x2: d[o + 2], y2: d[o + 3],
      score: d[o + 4],
      coefs: d.subarray(o + 6, o + 6 + nm),
    });
  }
  return boxes;
}

/* Salida cruda [1, 4 + nc + nm, anclas]: cx, cy, w, h, puntaje por clase, coeficientes. Requiere NMS. */
function parseRaw(output, nm, conf) {
  const [, channels, anchors] = output.dims;
  const d = output.data;
  const nc = channels - 4 - nm;
  const candidates = [];
  for (let a = 0; a < anchors; a++) {
    const score = d[(4 + config.classId) * anchors + a];
    if (score < conf) continue;
    const cx = d[a];
    const cy = d[anchors + a];
    const w = d[2 * anchors + a];
    const h = d[3 * anchors + a];
    const coefs = new Float32Array(nm);
    for (let k = 0; k < nm; k++) coefs[k] = d[(4 + nc + k) * anchors + a];
    candidates.push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, score, coefs });
  }
  candidates.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of candidates) {
    if (kept.every((k) => iou(k, box) <= NMS_IOU)) kept.push(box);
  }
  return kept;
}

function iou(a, b) {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter);
}

/*
 * Une las máscaras de todas las naranjas en una sola. Cada máscara es sigmoide(coeficientes ·
 * prototipos), recortada a su caja; sigmoide > 0.5 equivale a que el producto sea > 0.
 */
function paintInstances(boxes, protos, { scale, padX, padY }, image, out) {
  const [, nm, mh, mw] = protos.dims;
  const p = protos.data;
  const area = mh * mw;
  const toProto = mw / config.imgsz;
  // Coordenada del modelo (letterbox) de cada píxel de la máscara de salida.
  const sx = image.width / out.width;
  const sy = image.height / out.height;
  const modelX = (u) => ((u + 0.5) * sx) * scale + padX;
  const modelY = (v) => ((v + 0.5) * sy) * scale + padY;

  for (const box of boxes) {
    // Región de prototipos que cubre la caja, con un margen para interpolar.
    const px0 = Math.max(0, Math.floor(box.x1 * toProto) - 1);
    const py0 = Math.max(0, Math.floor(box.y1 * toProto) - 1);
    const px1 = Math.min(mw - 1, Math.ceil(box.x2 * toProto) + 1);
    const py1 = Math.min(mh - 1, Math.ceil(box.y2 * toProto) + 1);
    const rw = px1 - px0 + 1;
    const rh = py1 - py0 + 1;
    if (rw < 2 || rh < 2) continue;
    const logits = new Float32Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const idx = (py0 + y) * mw + px0 + x;
        let sum = 0;
        for (let k = 0; k < nm; k++) sum += box.coefs[k] * p[k * area + idx];
        logits[y * rw + x] = sum;
      }
    }

    // Píxeles de salida dentro de la caja.
    const u0 = Math.max(0, Math.floor(((box.x1 - padX) / scale) / sx));
    const u1 = Math.min(out.width - 1, Math.ceil(((box.x2 - padX) / scale) / sx));
    const v0 = Math.max(0, Math.floor(((box.y1 - padY) / scale) / sy));
    const v1 = Math.min(out.height - 1, Math.ceil(((box.y2 - padY) / scale) / sy));
    for (let v = v0; v <= v1; v++) {
      const my = modelY(v);
      if (my < box.y1 || my > box.y2) continue;
      // Interpolación bilineal entre los 4 prototipos más cercanos.
      const fy = Math.min(Math.max(my * toProto - 0.5 - py0, 0), rh - 1);
      const y0 = Math.min(Math.floor(fy), rh - 2);
      const ty = fy - y0;
      for (let u = u0; u <= u1; u++) {
        const o = v * out.width + u;
        if (out.mask[o]) continue;
        const mx = modelX(u);
        if (mx < box.x1 || mx > box.x2) continue;
        const fx = Math.min(Math.max(mx * toProto - 0.5 - px0, 0), rw - 1);
        const x0 = Math.min(Math.floor(fx), rw - 2);
        const tx = fx - x0;
        const i = y0 * rw + x0;
        const top = logits[i] + (logits[i + 1] - logits[i]) * tx;
        const bottom = logits[i + rw] + (logits[i + rw + 1] - logits[i + rw]) * tx;
        if (top + (bottom - top) * ty > 0) out.mask[o] = 1;
      }
    }
  }
}

async function segmentWithModel(imageData) {
  const { tensor, transform } = toTensor(imageData);
  const outputs = await session.run({ [session.inputNames[0]]: tensor });
  const values = Object.values(outputs);
  const protos = values.find((t) => t.dims.length === 4);
  const detections = values.find((t) => t.dims.length === 3);
  const nm = protos.dims[1];
  const conf = config.conf ?? 0.25;

  const boxes = detections.dims[2] === 6 + nm
    ? parseDetections(detections, nm, conf)
    : parseRaw(detections, nm, conf);

  const factor = MASK_SIZE / Math.max(imageData.width, imageData.height);
  const width = Math.max(1, Math.round(imageData.width * factor));
  const height = Math.max(1, Math.round(imageData.height * factor));
  const out = { mask: new Uint8Array(width * height), width, height };
  paintInstances(boxes, protos, transform, imageData, out);
  return result(out.mask, width, height, boxes.length);
}

/* ---------- API pública ---------- */

function result(mask, width, height, count) {
  let marked = 0;
  for (let p = 0; p < mask.length; p++) marked += mask[p];
  return { mask, width, height, coverage: marked / mask.length, count };
}

let loading = null;

export function loadModel() {
  loading ??= loadOnnx()
    .catch((error) => {
      console.warn('Modelo ONNX no disponible, se usa la simulación por color.', error);
      session = null;
      Object.assign(MODEL_INFO, {
        name: 'Simulación por color (tono naranja en HSV)',
        simulated: true,
        reason: error.message,
        inputSize: SIM_SIZE,
      });
    })
    .then(() => {
      MODEL_INFO.status = 'ready';
      return MODEL_INFO;
    });
  return loading;
}

// ONNX Runtime no admite dos inferencias simultáneas en la misma sesión: se encolan.
let queue = Promise.resolve();

/**
 * @param {ImageData} imageData
 * @returns {Promise<{mask: Uint8Array, width: number, height: number, coverage: number, count: number}>}
 */
export function segment(imageData) {
  const run = queue.then(async () => {
    await loadModel();
    return session ? segmentWithModel(imageData) : segmentByColor(imageData);
  });
  queue = run.catch(() => {});
  return run;
}
