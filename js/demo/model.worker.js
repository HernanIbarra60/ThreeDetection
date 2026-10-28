/*
 * Inferencia de YOLO26n-seg en un hilo aparte. ONNX Runtime Web ocupa el hilo donde corre: en el
 * principal congelaba el video y el naranjal 3D mientras procesaba cada frame.
 *
 * Mensajes (todos llevan el `id` del pedido):
 *   → { type: 'load', modelDir }      ← { type: 'loaded', name, imgsz, backend }
 *   → { type: 'segment', imageData }  ← { type: 'result', mask, width, height, count, backend }
 *   ← { type: 'error', message } si algo falla.
 */

// Los workers no ven el importmap de index.html: la URL va completa. Este paquete trae WebGPU y WASM.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.webgpu.min.mjs';

// Lado mayor de la máscara devuelta: los prototipos del modelo son de 160x160, más no aporta.
const MASK_SIZE = 320;
// Solo para salidas crudas sin NMS ([1, 4 + clases + 32, anclas]).
const NMS_IOU = 0.7;
const LETTERBOX_GRAY = 'rgb(114, 114, 114)';

let session = null;
let backend = null;
let modelBytes = null;
let config = null;
let letterbox = null;
let source = null;

async function createSession(name) {
  session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: [name],
    graphOptimizationLevel: 'all',
  });
  backend = name;
}

async function loadOnnx(modelDir) {
  const response = await fetch(`${modelDir}model.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`no se encontró ${modelDir}model.json`);
  config = await response.json();
  // Se revalida igual que model.json: si no, el navegador podría juntar un model.json nuevo con un .onnx viejo.
  const model = await fetch(`${modelDir}${config.file ?? 'orange-seg.onnx'}`, { cache: 'no-cache' });
  if (!model.ok) throw new Error(`no se encontró ${modelDir}${config.file ?? 'orange-seg.onnx'}`);
  modelBytes = new Uint8Array(await model.arrayBuffer());

  // WebGPU corre en la placa de video; si el navegador no lo tiene o falla, se usa la CPU (WASM).
  let lastError = null;
  for (const name of navigator.gpu ? ['webgpu', 'wasm'] : ['wasm']) {
    try {
      await createSession(name);
      break;
    } catch (error) {
      console.warn(`ONNX Runtime: no se pudo usar ${name}.`, error);
      lastError = error;
    }
  }
  if (!session) throw lastError;

  const size = config.imgsz;
  letterbox = new OffscreenCanvas(size, size);
  source = new OffscreenCanvas(1, 1);
}

/* Si WebGPU falla al ejecutar (por ejemplo, una operación no soportada), se pasa a WASM y se reintenta. */
async function run(feeds) {
  try {
    return await session.run(feeds);
  } catch (error) {
    if (backend === 'wasm') throw error;
    console.warn(`ONNX Runtime: falló ${backend} al ejecutar, se pasa a wasm.`, error);
    await createSession('wasm');
    return session.run(feeds);
  }
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
  const outputs = await run({ [session.inputNames[0]]: tensor });
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
  return { mask: out.mask, width, height, count: boxes.length };
}

let loading = null;

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'load') {
      loading ??= loadOnnx(data.modelDir);
      await loading;
      self.postMessage({ id, type: 'loaded', name: config.name ?? 'YOLO26n-seg', imgsz: config.imgsz, backend });
    } else if (type === 'segment') {
      const out = await segmentWithModel(data.imageData);
      self.postMessage({ id, type: 'result', ...out, backend }, [out.mask.buffer]);
    }
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error?.message ?? String(error) });
  }
};
