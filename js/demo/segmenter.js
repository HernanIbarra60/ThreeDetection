/*
 * Interfaz del modelo de segmentación.
 *
 * Para usar el modelo real, reemplazar el cuerpo de `loadModel()` y `segment()`
 * manteniendo el mismo contrato:
 *   - entrada:  ImageData (RGBA) del frame o de la imagen subida.
 *   - salida:   { mask, width, height, coverage }
 *       mask      Uint8Array de width * height con 1 = árbol, 0 = fondo.
 *       coverage  fracción de píxeles marcados como árbol (0 a 1).
 *
 * Ejemplo con ONNX Runtime Web (cuando exista el modelo exportado):
 *   const session = await ort.InferenceSession.create('model/tree-seg.onnx');
 *   const output = await session.run({ input: tensorDesdeImageData });
 *   mask[i] = output.logits.data[i] > 0 ? 1 : 0;
 */

export const MODEL_INFO = {
  name: 'Simulación por color (índice de exceso de verde)',
  simulated: true,
  inputWidth: 192,
};

// Umbral sobre el índice de exceso de verde normalizado (2g - r - b).
const EXG_THRESHOLD = 0.08;
// Píxeles muy oscuros tienen color poco confiable.
const MIN_BRIGHTNESS = 45;

export async function loadModel() {
  return MODEL_INFO;
}

/**
 * @param {ImageData} imageData
 * @returns {Promise<{mask: Uint8Array, width: number, height: number, coverage: number}>}
 */
export async function segment(imageData) {
  const { data, width, height } = imageData;
  const raw = new Uint8Array(width * height);

  for (let i = 0, p = 0; p < raw.length; i += 4, p++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const sum = r + g + b;
    if (sum < MIN_BRIGHTNESS * 3) continue;
    const exg = (2 * g - r - b) / sum;
    raw[p] = exg > EXG_THRESHOLD ? 1 : 0;
  }

  const mask = majorityFilter(raw, width, height);
  let count = 0;
  for (let p = 0; p < mask.length; p++) count += mask[p];

  return { mask, width, height, coverage: count / mask.length };
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
