import { Webcam, describeCameraError } from './camera.js';
import { loadModel, segment, MODEL_INFO } from './segmenter.js';

const MASK_FILL = [96, 214, 82, 140];
const MASK_EDGE = [214, 255, 150, 235];
const MAX_DISPLAY_WIDTH = 1280;

export function initDemo() {
  const cameraButton = document.getElementById('camera-toggle');
  const imageInput = document.getElementById('image-input');
  const maskToggle = document.getElementById('mask-toggle');
  const stage = document.getElementById('stage-canvas');
  const video = document.getElementById('camera-video');
  const placeholder = document.getElementById('stage-placeholder');
  const status = document.getElementById('demo-status');
  const coverage = document.getElementById('coverage-value');

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

  loadModel();

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.classList.toggle('is-error', isError);
  }

  function setCameraButton(active) {
    cameraButton.textContent = active ? 'Desactivar cámara' : 'Activar cámara';
    cameraButton.setAttribute('aria-pressed', String(active));
  }

  function showPlaceholder() {
    stage.hidden = true;
    placeholder.hidden = false;
    coverage.textContent = '—';
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

  async function processFrame(source, sourceWidth, sourceHeight, mirror) {
    const scale = Math.min(1, MAX_DISPLAY_WIDTH / sourceWidth);
    const displayWidth = Math.round(sourceWidth * scale);
    const displayHeight = Math.round(sourceHeight * scale);
    resizeCanvas(stage, displayWidth, displayHeight);
    stage.hidden = false;
    placeholder.hidden = true;

    // El modelo trabaja sobre una versión reducida del frame.
    const workWidth = MODEL_INFO.inputWidth;
    const workHeight = Math.max(1, Math.round((sourceHeight / sourceWidth) * workWidth));
    resizeCanvas(work, workWidth, workHeight);
    workCtx.drawImage(source, 0, 0, workWidth, workHeight);
    const result = await segment(workCtx.getImageData(0, 0, workWidth, workHeight));

    stageCtx.save();
    if (mirror) {
      stageCtx.translate(displayWidth, 0);
      stageCtx.scale(-1, 1);
    }
    stageCtx.drawImage(source, 0, 0, displayWidth, displayHeight);
    if (maskToggle.checked) {
      paintMask(result);
      stageCtx.imageSmoothingEnabled = true;
      stageCtx.imageSmoothingQuality = 'high';
      stageCtx.drawImage(maskCanvas, 0, 0, displayWidth, displayHeight);
    }
    stageCtx.restore();

    coverage.textContent = `${(result.coverage * 100).toFixed(1)} %`;
  }

  async function cameraLoop(id) {
    if (id !== loopId || mode !== 'camera') return;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      await processFrame(video, video.videoWidth, video.videoHeight, true);
    }
    requestAnimationFrame(() => cameraLoop(id));
  }

  function stopCamera() {
    webcam.stop();
    loopId++;
    setCameraButton(false);
    if (image) {
      mode = 'image';
      processFrame(image, image.naturalWidth, image.naturalHeight, false);
    } else {
      mode = 'idle';
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
      await webcam.start();
      mode = 'camera';
      setCameraButton(true);
      setStatus('Cámara activa: segmentando en tiempo real.');
      loopId++;
      cameraLoop(loopId);
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
      if (webcam.active) stopCamera();
      image = img;
      mode = 'image';
      await processFrame(img, img.naturalWidth, img.naturalHeight, false);
      setStatus(`Imagen analizada: ${file.name}`);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setStatus('No se pudo leer la imagen.', true);
    };
    img.src = url;
  });

  maskToggle.addEventListener('change', () => {
    if (mode === 'image' && image) {
      processFrame(image, image.naturalWidth, image.naturalHeight, false);
    }
  });

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus('La cámara solo funciona en HTTPS o en localhost. Igual podés subir una imagen.', true);
  }
}
