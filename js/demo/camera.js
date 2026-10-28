const RESOLUTION = { width: { ideal: 1280 }, height: { ideal: 720 } };

export class Webcam {
  #stream = null;

  constructor(video) {
    this.video = video;
  }

  get active() {
    return this.#stream !== null;
  }

  /* Id de la cámara en uso, o null si está apagada. */
  get deviceId() {
    return this.#stream?.getVideoTracks()[0]?.getSettings().deviceId ?? null;
  }

  /* Cámaras disponibles. Los nombres solo aparecen después de dar permiso. */
  static async list() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'videoinput' && device.deviceId)
      .map((device, i) => ({ deviceId: device.deviceId, label: device.label || `Cámara ${i + 1}` }));
  }

  async start(deviceId = null) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      const error = new Error('Contexto inseguro');
      error.name = 'InsecureContextError';
      throw error;
    }

    const video = deviceId
      ? { ...RESOLUTION, deviceId: { exact: deviceId } }
      : { ...RESOLUTION, facingMode: 'user' };
    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (error) {
      // La cámara elegida ya no está conectada: se usa la que dé el navegador.
      if (!deviceId || !['OverconstrainedError', 'NotFoundError'].includes(error.name)) throw error;
      return this.start(null);
    }
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
