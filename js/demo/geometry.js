/*
 * Modelo geométrico de AGRO-YOLO-V (Sukkuea et al., IEEE Access 2026, DOI 10.1109/ACCESS.2026.3667161),
 * adaptado a una cámara monocular sin profundidad. Funciones puras: las usan el worker del modelo,
 * la simulación por color, la demo y la página de validación.
 *
 * Unidades: radio aparente r, área A y distancia focal f en píxeles de la máscara; distancias y
 * diámetros en mm; volúmenes en mL.
 *
 * Una instancia es { pixels, hullArea, minU, maxU, minV, maxV, cx, cy, score, touchesEdge }, con
 * coordenadas en índices de píxel de la máscara.
 */

export const DEFAULT_DIAMETER_MM = 75;
export const DEFAULT_DISTANCE_CM = 50;
export const DEFAULT_HFOV_DEG = 70;

// Franja (en píxeles) que se suma a la envolvente de los centros de píxel: ver hullAreaFromRows.
const HULL_BORDER = 0.3;

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/* Envolvente convexa por cadena monótona (Andrew). Devuelve los vértices en sentido antihorario. */
function convexHull(points) {
  if (points.length < 3) return points.slice();
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Área de la envolvente convexa de una máscara, como en el paper: envolvente más fórmula del cordón
 * de zapato. Alcanza con los extremos de cada fila, porque los puntos interiores nunca son vértices.
 *
 * Los extremos son centros de píxel y el borde real de la fruta queda un poco más afuera. Por eso
 * al polígono se le suma una franja de HULL_BORDER píxeles (suma de Minkowski con un disco:
 * c·perímetro + π·c²). Sin corrección, en discos digitales el radio sale entre 0,25 y 0,45 px más
 * chico (un 4 % menos con 10 px de radio); con c = 0,3 el sesgo queda por debajo de 0,13 px entre
 * 3 y 80 px de radio. Medio píxel sobrecompensa, porque el hueco es de medio píxel solo en sentido
 * horizontal y la envolvente elige justo los extremos más salidos.
 *
 * @param {Array<[number, number, number]>} rows Filas [v, uMin, uMax] con algún píxel de la instancia.
 * @returns {number} Área en píxeles².
 */
export function hullAreaFromRows(rows) {
  const points = [];
  for (const [v, uMin, uMax] of rows) {
    points.push([uMin, v]);
    if (uMax !== uMin) points.push([uMax, v]);
  }
  if (points.length === 0) return 0;
  const hull = convexHull(points);
  let twiceArea = 0;
  let perimeter = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    twiceArea += x1 * y2 - x2 * y1;
    perimeter += Math.hypot(x2 - x1, y2 - y1);
  }
  // Con uno o dos puntos el bucle igual da bien: un segmento cuenta su largo ida y vuelta.
  return Math.abs(twiceArea) / 2 + HULL_BORDER * perimeter + Math.PI * HULL_BORDER ** 2;
}

/** Distancia focal en píxeles para una imagen de `width` píxeles y un campo de visión horizontal. */
export function focalFromFov(width, hfovDeg) {
  return width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
}

/** Campo de visión horizontal (°) equivalente a una distancia focal normalizada f / W. */
export function fovFromFocalRatio(focalRatio) {
  return (360 / Math.PI) * Math.atan(0.5 / focalRatio);
}

/** Radio del círculo con la misma área que la envolvente convexa. */
export function apparentRadius(instance) {
  return Math.sqrt(instance.hullArea / Math.PI);
}

/**
 * Distancia de la cámara al centro de una esfera de diámetro conocido. La silueta de la esfera
 * subtiende un semiángulo θ con tan θ = r / f y sen θ = R / Z, de donde Z = R·√(1 + (f / r)²).
 */
export function distanceToCenter(r, f, diameterMm) {
  return (diameterMm / 2) * Math.sqrt(1 + (f / r) ** 2);
}

/** Diámetro de una esfera cuyo centro está a `distanceMm` de la cámara: D = 2Z·sen(arctan(r / f)). */
export function sizeAtDistance(r, f, distanceMm) {
  return 2 * distanceMm * Math.sin(Math.atan(r / f));
}

/**
 * Volumen con las ecuaciones 1 y 3 del paper: V = k·A^(3/2), con k = 4 / (3√π) · (Z / f)³.
 * (Z / f) pasa píxeles a mm a la distancia Z; el resto es el volumen de la esfera de área A.
 * @returns {number} Volumen en mL.
 */
export function volumeAgro(area, f, distanceMm) {
  const k = (4 / (3 * Math.sqrt(Math.PI))) * (distanceMm / f) ** 3;
  return (k * area ** 1.5) / 1000;
}

/**
 * Distancia focal normalizada (f / W) a partir de una naranja de diámetro conocido a una distancia
 * medida. Es la inversa de distanceToCenter: f = r·√((Z / R)² − 1).
 * @returns {number|null} f / W, o null si la distancia es menor que el radio.
 */
export function calibrateFocal(r, width, distanceMm, diameterMm) {
  const ratio = distanceMm / (diameterMm / 2);
  if (!(ratio > 1) || !(r > 0) || !(width > 0)) return null;
  return (r * Math.sqrt(ratio ** 2 - 1)) / width;
}

function formatDistance(mm) {
  if (mm < 1000) return `${Math.round(mm / 10)} cm`;
  return `${(mm / 1000).toFixed(2).replace('.', ',')} m`;
}

/**
 * Mide cada instancia de un resultado de segment(). Las que tocan el borde quedan como no válidas.
 * @param {{width: number, instances: object[]}} result
 * @param {{mode: 'off'|'distance'|'size', focalRatio: number, diameterMm: number, distanceMm: number}} settings
 * @returns {Array<{instance: object, valid: boolean, label: string, distanceMm?: number,
 *   diameterMm?: number, volumeMl?: number}>}
 */
export function measureInstances({ width, instances = [] }, { mode, focalRatio, diameterMm, distanceMm }) {
  if (mode !== 'distance' && mode !== 'size') return [];
  const f = focalRatio * width;
  return instances.map((instance) => {
    if (instance.touchesEdge || !(instance.hullArea > 0)) return { instance, valid: false, label: '?' };
    const r = apparentRadius(instance);
    if (mode === 'distance') {
      const z = distanceToCenter(r, f, diameterMm);
      return { instance, valid: true, distanceMm: z, label: `≈ ${formatDistance(z)}` };
    }
    const d = sizeAtDistance(r, f, distanceMm);
    const v = volumeAgro(instance.hullArea, f, distanceMm);
    return { instance, valid: true, diameterMm: d, volumeMl: v, label: `Ø ${Math.round(d)} mm · ${Math.round(v)} mL` };
  });
}
