export class Webcam {
  #stream = null;

  constructor(video) {
    this.video = video;
  }

  get active() {
    return this.#stream !== null;
  }

  async start() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      const error = new Error('Contexto inseguro');
      error.name = 'InsecureContextError';
      throw error;
    }

    this.#stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = this.#stream;
    try {
      await this.video.play();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = null;
    this.video.pause();
    this.video.srcObject = null;
  }
}

export function describeCameraError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'No se dio permiso para usar la cámara. Habilitalo desde la configuración del navegador.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No se encontró ninguna cámara en este dispositivo.';
    case 'NotReadableError':
      return 'La cámara está siendo usada por otra aplicación.';
    case 'InsecureContextError':
      return 'La cámara solo funciona en HTTPS o en localhost.';
    default:
      return 'No se pudo iniciar la cámara.';
  }
}
