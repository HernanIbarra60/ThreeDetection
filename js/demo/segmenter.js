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
 * YOLO26n-seg con ONNX Runtime Web en un Web Worker (model.worker.js), con WebGPU si el navegador
 * lo tiene. Si no, la máscara se simula detectando los píxeles de color naranja, así la página
 * funciona igual antes de exportar el modelo.
 */

const MODEL_DIR = 'model/';

export const MODEL_INFO = {
  name: 'Cargando modelo…',
  status: 'loading', // 'loading' | 'ready'
  simulated: true,
  reason: '',
  inputSize: 256,
  backend: '', // 'webgpu' | 'wasm' con el modelo real
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

/* ---------- Modelo real: YOLO26n-seg en un Web Worker (model.worker.js) ---------- */

let worker = null;
let nextId = 0;
const pending = new Map();

/* Manda un pedido al worker y espera su respuesta (cada una trae el id del pedido). */
function call(message, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...message, id }, transfer);
  });
}

async function loadOnnx() {
  worker = new Worker(new URL('./model.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.type === 'error') request.reject(new Error(data.message));
    else request.resolve(data);
  };
  // Si el worker no arranca (por ejemplo, no se pudo descargar ONNX Runtime) falla todo lo pendiente.
  worker.onerror = (event) => {
    const error = new Error(event.message || 'no se pudo iniciar el worker del modelo');
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  // El worker resuelve las rutas relativas a su propio archivo: se le pasa la carpeta absoluta.
  const info = await call({ type: 'load', modelDir: new URL(MODEL_DIR, document.baseURI).href });
  Object.assign(MODEL_INFO, {
    name: info.name,
    simulated: false,
    inputSize: info.imgsz,
    backend: info.backend,
  });
}

async function segmentWithModel(imageData) {
  // El buffer del frame se transfiere al worker en vez de copiarse.
  const out = await call({ type: 'segment', imageData }, [imageData.data.buffer]);
  MODEL_INFO.backend = out.backend;
  return result(out.mask, out.width, out.height, out.count);
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
      worker?.terminate();
      worker = null;
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
    return worker ? segmentWithModel(imageData) : segmentByColor(imageData);
  });
  queue = run.catch(() => {});
  return run;
}
