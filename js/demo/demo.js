import { Webcam, describeCameraError } from './camera.js';
import { loadModel, segment, MODEL_INFO } from './segmenter.js';
import {
  DEFAULT_DIAMETER_MM, DEFAULT_DISTANCE_CM, DEFAULT_HFOV_DEG,
  apparentRadius, calibrateFocal, focalFromFov, fovFromFocalRatio, measureInstances,
} from './geometry.js';

// Rojo anaranjado y borde claro: sobre naranjas un relleno del mismo tono casi no se nota.
const MASK_FILL = [255, 84, 0, 150];
const MASK_EDGE = [255, 248, 215, 255];
const MAX_DISPLAY_WIDTH = 1280;
// Cámara elegida la última vez (por ejemplo, una webcam USB en vez de la integrada).
const CAMERA_KEY = 'threedetection.camera';
// Configuración de la medición y distancia focal calibrada (f / ancho de la imagen).
const MEASURE_KEY = 'threedetection.measure';
const FOCAL_KEY = 'threedetection.focal';
const LABEL_FILL = 'rgba(34, 54, 31, 0.85)';
const LABEL_FILL_INVALID = 'rgba(107, 76, 50, 0.85)';
const LABEL_TEXT = '#fffcf6';

function savedCamera() {
  try {
    return localStorage.getItem(CAMERA_KEY);
  } catch {
    return null;
  }
}

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Sin almacenamiento solo no se recuerda la configuración.
  }
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function savedMeasureSettings() {
  let saved = {};
  try {
    saved = JSON.parse(readStorage(MEASURE_KEY)) ?? {};
  } catch {
    // Valor corrupto: se usan los de fábrica.
  }
  return {
    mode: ['off', 'distance', 'size'].includes(saved.mode) ? saved.mode : 'off',
    diameterMm: positive(saved.diameterMm, DEFAULT_DIAMETER_MM),
    distanceCm: positive(saved.distanceCm, DEFAULT_DISTANCE_CM),
    hfovDeg: positive(saved.hfovDeg, DEFAULT_HFOV_DEG),
  };
}

function savedFocal() {
  const value = Number(readStorage(FOCAL_KEY));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/* Lee un número escrito con coma o con punto decimal. */
function parseNumber(text) {
  return Number(String(text ?? '').trim().replace(',', '.'));
}

function saveCamera(deviceId) {
  try {
    localStorage.setItem(CAMERA_KEY, deviceId);
  } catch {
    // Sin almacenamiento (ventana privada, por ejemplo) solo no se recuerda la elección.
  }
}

export function initDemo() {
  const cameraButton = document.getElementById('camera-toggle');
  const cameraPicker = document.getElementById('camera-picker');
  const cameraSelect = document.getElementById('camera-select');
  const imageInput = document.getElementById('image-input');
  const maskToggle = document.getElementById('mask-toggle');
  const stage = document.getElementById('stage-canvas');
  const video = document.getElementById('camera-video');
  const placeholder = document.getElementById('stage-placeholder');
  const status = document.getElementById('demo-status');
  const notice = document.getElementById('model-notice');
  const countValue = document.getElementById('count-value');
  const coverage = document.getElementById('coverage-value');
  const speedValue = document.getElementById('speed-value');
  const measureMode = document.getElementById('measure-mode');
  const measureValue = document.getElementById('measure-value');
  const measureValueLabel = document.getElementById('measure-value-label');
  const measureFov = document.getElementById('measure-fov');
  const calibrateButton = document.getElementById('measure-calibrate');
  const resetButton = document.getElementById('measure-reset');
  const measureDetails = document.querySelectorAll('[data-measure-detail]');
  const measureStatLabel = document.getElementById('measure-stat-label');
  const measureStatValue = document.getElementById('measure-stat-value');

  const stageCtx = stage.getContext('2d');
  const work = document.createElement('canvas');
  const workCtx = work.getContext('2d', { willReadFrequently: true });
  const maskCanvas = document.createElement('canvas');
  const maskCtx = maskCanvas.getContext('2d');

  const webcam = new Webcam(video);
  let mode = 'idle';
  let image = null;
  let loopId = 0;
  let busy = false;
  // Última máscara calculada y número de la última inferencia pedida (descarta resultados viejos).
  let lastResult = null;
  // Medición de cada naranja de lastResult (etiquetas sobre la imagen).
  let lastMeasures = [];
  let requestId = 0;
  let inferring = false;
  // Backend que muestra el aviso: si WebGPU falla en plena ejecución, el worker pasa a WASM.
  let shownBackend = null;

  const settings = savedMeasureSettings();
  let focalRatio = savedFocal();

  loadModel().then(showModelNotice);

  function showModelNotice() {
    const title = document.createElement('strong');
    let text;
    if (MODEL_INFO.status === 'loading') {
      title.textContent = 'Cargando modelo…';
      text = ' La primera vez descarga unos 25 MB.';
    } else if (MODEL_INFO.simulated) {
      title.textContent = 'Máscara simulada:';
      text = ' no se encontró el modelo en model/, así que la segmentación se aproxima ' +
        'detectando los colores naranjas de la imagen.';
    } else {
      const where = MODEL_INFO.backend === 'webgpu' ? 'la placa de video (WebGPU)' : 'el procesador (WASM)';
      title.textContent = `Modelo: ${MODEL_INFO.name}.`;
      text = ` Corre en tu navegador con ONNX Runtime Web, en ${where}: las imágenes no salen de tu computadora.`;
    }
    shownBackend = MODEL_INFO.backend;
    notice.replaceChildren(title, text);
    notice.classList.toggle('is-simulated', MODEL_INFO.simulated && MODEL_INFO.status === 'ready');
  }
  showModelNotice();

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.classList.toggle('is-error', isError);
  }

  /* Llena el selector de cámaras. Solo se muestra si hay más de una. */
  async function refreshCameras() {
    let cameras = [];
    try {
      cameras = await Webcam.list();
    } catch (error) {
      console.warn('No se pudo listar las cámaras.', error);
    }
    const current = webcam.deviceId ?? savedCamera();
    cameraSelect.replaceChildren(...cameras.map(({ deviceId, label }) => new Option(label, deviceId)));
    if (cameras.some((camera) => camera.deviceId === current)) cameraSelect.value = current;
    cameraPicker.hidden = cameras.length < 2;
  }

  function setCameraButton(active) {
    cameraButton.textContent = active ? 'Desactivar cámara' : 'Activar cámara';
    cameraButton.setAttribute('aria-pressed', String(active));
  }

  function showStats(result, ms) {
    countValue.textContent = result ? String(result.count) : '—';
    coverage.textContent = result ? `${(result.coverage * 100).toFixed(1)} %` : '—';
    speedValue.textContent = result ? `${Math.round(ms)} ms · ${(1000 / ms).toFixed(1)} FPS` : '—';
  }

  function showPlaceholder() {
    stage.hidden = true;
    placeholder.hidden = false;
    setResult(null);
    showStats(null);
  }

  /* ---------- Medición ---------- */

  function currentFocalRatio() {
    return focalRatio ?? focalFromFov(1, settings.hfovDeg);
  }

  function measure(result) {
    if (!result) return [];
    return measureInstances(result, {
      mode: settings.mode,
      focalRatio: currentFocalRatio(),
      diameterMm: settings.diameterMm,
      distanceMm: settings.distanceCm * 10,
    });
  }

  function setResult(result) {
    lastResult = result;
    lastMeasures = measure(result);
    showMeasureStat();
  }

  function showMeasureStat() {
    const valid = lastMeasures.filter((m) => m.valid);
    if (settings.mode === 'distance') {
      measureStatLabel.textContent = 'Más cercana';
      const nearest = Math.min(...valid.map((m) => m.distanceMm));
      measureStatValue.textContent = valid.length ? `${Math.round(nearest / 10)} cm` : '—';
    } else if (settings.mode === 'size') {
      measureStatLabel.textContent = 'Volumen medio';
      const mean = valid.reduce((sum, m) => sum + m.volumeMl, 0) / valid.length;
      measureStatValue.textContent = valid.length ? `${Math.round(mean)} mL` : '—';
    } else {
      measureStatLabel.textContent = 'Medición';
      measureStatValue.textContent = '—';
    }
  }

  function saveMeasureSettings() {
    writeStorage(MEASURE_KEY, JSON.stringify(settings));
  }

  /* Muestra los controles del modo actual. Con calibración, el campo de visión es el equivalente. */
  function showMeasureControls() {
    measureMode.value = settings.mode;
    for (const element of measureDetails) element.hidden = settings.mode === 'off';
    if (settings.mode === 'size') {
      measureValueLabel.textContent = 'Distancia de la cámara (cm)';
      measureValue.value = String(settings.distanceCm);
    } else {
      measureValueLabel.textContent = 'Diámetro de la naranja (mm)';
      measureValue.value = String(settings.diameterMm);
    }
    measureFov.disabled = focalRatio !== null;
    measureFov.value = String(Math.round(focalRatio !== null ? fovFromFocalRatio(focalRatio) : settings.hfovDeg));
    measureFov.title = focalRatio !== null ? 'Calculado con la calibración. Usá "Restablecer" para volver a escribirlo.' : '';
    resetButton.hidden = settings.mode === 'off' || focalRatio === null;
  }

  /* Recalcula las etiquetas con la configuración nueva sin volver a correr el modelo. */
  function remeasure() {
    lastMeasures = measure(lastResult);
    showMeasureStat();
    if (mode === 'image' && image) draw(image, image.naturalWidth, image.naturalHeight, false);
  }

  /* Etiquetas sobre cada naranja. Con la cámara se espeja la posición, pero no el texto. */
  function drawLabels(displayWidth, displayHeight, mirror) {
    if (!lastResult || lastMeasures.length === 0) return;
    const sx = displayWidth / lastResult.width;
    const sy = displayHeight / lastResult.height;
    const fontSize = Math.max(12, Math.round(displayWidth / 60));
    const boxHeight = fontSize + 8;
    stageCtx.save();
    stageCtx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
    stageCtx.textAlign = 'center';
    stageCtx.textBaseline = 'middle';
    for (const { instance, label, valid } of lastMeasures) {
      const boxWidth = stageCtx.measureText(label).width + 12;
      let x = ((instance.minU + instance.maxU + 1) / 2) * sx;
      if (mirror) x = displayWidth - x;
      x = Math.min(Math.max(x, boxWidth / 2), displayWidth - boxWidth / 2);
      // Arriba de la naranja; si no entra, en el centro.
      let y = instance.minV * sy - boxHeight / 2 - 4;
      if (y - boxHeight / 2 < 0) y = ((instance.minV + instance.maxV + 1) / 2) * sy;
      stageCtx.fillStyle = valid ? LABEL_FILL : LABEL_FILL_INVALID;
      stageCtx.beginPath();
      if (stageCtx.roundRect) stageCtx.roundRect(x - boxWidth / 2, y - boxHeight / 2, boxWidth, boxHeight, boxHeight / 2);
      else stageCtx.rect(x - boxWidth / 2, y - boxHeight / 2, boxWidth, boxHeight);
      stageCtx.fill();
      stageCtx.fillStyle = LABEL_TEXT;
      stageCtx.fillText(label, x, y + 1);
    }
    stageCtx.restore();
  }

  showMeasureControls();
  showMeasureStat();

  function resizeCanvas(canvas, width, height) {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function paintMask({ mask, width, height }) {
    resizeCanvas(maskCanvas, width, height);
    const pixels = maskCtx.createImageData(width, height);
    const data = pixels.data;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (!mask[p]) continue;
        const edge =
          x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
          !mask[p - 1] || !mask[p + 1] || !mask[p - width] || !mask[p + width];
        data.set(edge ? MASK_EDGE : MASK_FILL, p * 4);
      }
    }
    maskCtx.putImageData(pixels, 0, 0);
  }

  /* Segmenta el frame actual de `source`. El frame se copia antes de esperar al modelo. */
  async function analyze(source, sourceWidth, sourceHeight) {
    const id = ++requestId;
    await loadModel();
    // El modelo recibe el frame con el lado mayor igual a su tamaño de entrada.
    const scale = MODEL_INFO.inputSize / Math.max(sourceWidth, sourceHeight);
    const workWidth = Math.max(1, Math.round(sourceWidth * scale));
    const workHeight = Math.max(1, Math.round(sourceHeight * scale));
    resizeCanvas(work, workWidth, workHeight);
    workCtx.drawImage(source, 0, 0, workWidth, workHeight);
    // Tiempo total del frame: preparar la imagen, pasarla al worker, inferir y armar la máscara.
    const start = performance.now();
    const result = await segment(workCtx.getImageData(0, 0, workWidth, workHeight));
    const ms = performance.now() - start;
    if (id !== requestId) return null;
    setResult(result);
    paintMask(result);
    showStats(result, ms);
    if (MODEL_INFO.backend !== shownBackend) showModelNotice();
    return result;
  }

  function draw(source, sourceWidth, sourceHeight, mirror) {
    const scale = Math.min(1, MAX_DISPLAY_WIDTH / sourceWidth);
    const displayWidth = Math.round(sourceWidth * scale);
    const displayHeight = Math.round(sourceHeight * scale);
    resizeCanvas(stage, displayWidth, displayHeight);
    stage.hidden = false;
    placeholder.hidden = true;

    stageCtx.save();
    if (mirror) {
      stageCtx.translate(displayWidth, 0);
      stageCtx.scale(-1, 1);
    }
    stageCtx.drawImage(source, 0, 0, displayWidth, displayHeight);
    if (maskToggle.checked && lastResult) {
      stageCtx.imageSmoothingEnabled = true;
      stageCtx.imageSmoothingQuality = 'high';
      stageCtx.drawImage(maskCanvas, 0, 0, displayWidth, displayHeight);
    }
    stageCtx.restore();
    drawLabels(displayWidth, displayHeight, mirror);
  }

  async function showImage(img) {
    setResult(null);
    draw(img, img.naturalWidth, img.naturalHeight, false);
    const result = await analyze(img, img.naturalWidth, img.naturalHeight);
    if (result && mode === 'image' && image === img) draw(img, img.naturalWidth, img.naturalHeight, false);
    return result;
  }

  /*
   * El video se dibuja en cada frame con la última máscara disponible. Mientras hay una
   * inferencia en curso no se lanza otra: con un modelo lento se saltean frames en vez de trabar el video.
   */
  function cameraLoop(id) {
    if (id !== loopId || mode !== 'camera') return;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      if (!inferring) {
        inferring = true;
        analyze(video, video.videoWidth, video.videoHeight)
          .catch((error) => {
            console.error(error);
            setStatus('Falló la segmentación del frame.', true);
          })
          .finally(() => { inferring = false; });
      }
      draw(video, video.videoWidth, video.videoHeight, true);
    }
    requestAnimationFrame(() => cameraLoop(id));
  }

  function stopCamera() {
    webcam.stop();
    loopId++;
    setCameraButton(false);
    if (image) {
      mode = 'image';
      showImage(image);
    } else {
      mode = 'idle';
      requestId++;
      showPlaceholder();
    }
  }

  cameraButton.addEventListener('click', async () => {
    if (busy) return;
    if (webcam.active) {
      stopCamera();
      setStatus('Cámara desactivada.');
      return;
    }

    busy = true;
    cameraButton.disabled = true;
    setStatus('Solicitando permiso para usar la cámara…');
    try {
      await webcam.start(cameraSelect.value || savedCamera());
      mode = 'camera';
      setResult(null);
      setCameraButton(true);
      setStatus('Cámara activa: buscando naranjas en tiempo real.');
      loopId++;
      cameraLoop(loopId);
      // Con el permiso dado ya se conocen los nombres de las cámaras.
      await refreshCameras();
    } catch (error) {
      console.error(error);
      setCameraButton(false);
      setStatus(describeCameraError(error), true);
    } finally {
      busy = false;
      cameraButton.disabled = false;
    }
  });

  imageInput.addEventListener('change', () => {
    const file = imageInput.files?.[0];
    imageInput.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setStatus('El archivo elegido no es una imagen.', true);
      return;
    }

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      URL.revokeObjectURL(url);
      if (webcam.active) {
        webcam.stop();
        loopId++;
        setCameraButton(false);
      }
      image = img;
      mode = 'image';
      setStatus(`Analizando ${file.name}…`);
      try {
        const result = await showImage(img);
        if (!result) return;
        const naranjas = result.count === 1 ? '1 naranja' : `${result.count} naranjas`;
        setStatus(`Imagen analizada: ${file.name} · ${naranjas}.`);
      } catch (error) {
        console.error(error);
        setStatus('No se pudo segmentar la imagen.', true);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setStatus('No se pudo leer la imagen.', true);
    };
    img.src = url;
  });

  cameraSelect.addEventListener('change', async () => {
    saveCamera(cameraSelect.value);
    if (!webcam.active || busy) return;
    // Cambio en caliente: el bucle sigue corriendo y retoma con el video de la cámara nueva.
    busy = true;
    cameraSelect.disabled = true;
    try {
      webcam.stop();
      requestId++; // descarta la máscara de un frame de la cámara anterior que siga en curso
      setResult(null);
      await webcam.start(cameraSelect.value);
      setStatus(`Cámara activa: ${cameraSelect.selectedOptions[0]?.text ?? 'cámara elegida'}.`);
    } catch (error) {
      console.error(error);
      stopCamera();
      setStatus(describeCameraError(error), true);
    } finally {
      busy = false;
      cameraSelect.disabled = false;
    }
  });

  navigator.mediaDevices?.addEventListener?.('devicechange', refreshCameras);
  refreshCameras();

  maskToggle.addEventListener('change', () => {
    if (mode === 'image' && image) draw(image, image.naturalWidth, image.naturalHeight, false);
  });

  measureMode.addEventListener('change', () => {
    settings.mode = measureMode.value;
    saveMeasureSettings();
    showMeasureControls();
    remeasure();
  });

  measureValue.addEventListener('input', () => {
    const value = parseNumber(measureValue.value);
    if (!(value > 0)) return;
    if (settings.mode === 'size') settings.distanceCm = value;
    else settings.diameterMm = value;
    saveMeasureSettings();
    remeasure();
  });

  measureFov.addEventListener('input', () => {
    const value = parseNumber(measureFov.value);
    if (!(value > 0 && value < 180)) return;
    settings.hfovDeg = value;
    saveMeasureSettings();
    remeasure();
  });

  /*
   * Calibración: con una naranja de diámetro conocido a una distancia medida se despeja f / W.
   * Vale para la cámara y la resolución con que se calibró (el zoom o el recorte la cambian).
   */
  calibrateButton.addEventListener('click', () => {
    const candidates = (lastResult?.instances ?? []).filter((i) => !i.touchesEdge && i.hullArea > 0);
    if (candidates.length === 0) {
      setStatus('Para calibrar hace falta una naranja entera en la imagen (que no toque el borde).', true);
      return;
    }
    // Se fija la naranja y el ancho antes del diálogo: con la cámara, lastResult sigue cambiando.
    const target = candidates.reduce((a, b) => (b.hullArea > a.hullArea ? b : a));
    const width = lastResult.width;
    const suggested = settings.mode === 'size' ? String(settings.distanceCm) : '';
    const answer = window.prompt(
      `Distancia real de la cámara al centro de la naranja más grande, en cm ` +
      `(se toma un diámetro de ${settings.diameterMm} mm):`,
      suggested,
    );
    if (answer === null) return;
    const distanceCm = parseNumber(answer);
    const ratio = distanceCm > 0 ? calibrateFocal(apparentRadius(target), width, distanceCm * 10, settings.diameterMm) : null;
    if (!ratio) {
      setStatus('Distancia no válida: tiene que ser mayor que el radio de la naranja.', true);
      return;
    }
    focalRatio = ratio;
    writeStorage(FOCAL_KEY, String(ratio));
    showMeasureControls();
    remeasure();
    setStatus(`Cámara calibrada: campo de visión horizontal equivalente de ${Math.round(fovFromFocalRatio(ratio))}°.`);
  });

  resetButton.addEventListener('click', () => {
    focalRatio = null;
    writeStorage(FOCAL_KEY, null);
    showMeasureControls();
    remeasure();
    setStatus('Calibración borrada: se usa el campo de visión.');
  });

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus('La cámara solo funciona en HTTPS o en localhost. Igual podés subir una imagen.', true);
  }
}
