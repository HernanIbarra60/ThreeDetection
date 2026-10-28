import { Webcam, describeCameraError } from './camera.js';
import { loadModel, segment, MODEL_INFO } from './segmenter.js';

// Rojo anaranjado y borde claro: sobre naranjas un relleno del mismo tono casi no se nota.
const MASK_FILL = [255, 84, 0, 150];
const MASK_EDGE = [255, 248, 215, 255];
const MAX_DISPLAY_WIDTH = 1280;
// Cámara elegida la última vez (por ejemplo, una webcam USB en vez de la integrada).
const CAMERA_KEY = 'threedetection.camera';

function savedCamera() {
  try {
    return localStorage.getItem(CAMERA_KEY);
  } catch {
    return null;
  }
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
  let requestId = 0;
  let inferring = false;
  // Backend que muestra el aviso: si WebGPU falla en plena ejecución, el worker pasa a WASM.
  let shownBackend = null;

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
    lastResult = null;
    showStats(null);
  }

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
    lastResult = result;
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
  }

  async function showImage(img) {
    lastResult = null;
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
      lastResult = null;
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
      lastResult = null;
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

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus('La cámara solo funciona en HTTPS o en localhost. Igual podés subir una imagen.', true);
  }
}
