# ThreeDetection

Página web del proyecto de segmentación de árboles de la cátedra de Inteligencia Artificial.

- **Bosque 3D** generado proceduralmente con [three.js](https://threejs.org/) (árboles, pasto y viento).
- **Demo de segmentación** con la webcam o subiendo una imagen.
- Sitio estático: HTML, CSS y JavaScript, sin paso de build.

> La segmentación actual es **simulada** (detecta píxeles verdes por color).
> El modelo real se integra reemplazando `loadModel()` y `segment()` en
> [`js/demo/segmenter.js`](js/demo/segmenter.js), respetando el contrato documentado ahí.

## Correr en local

Los módulos ES y la cámara no funcionan abriendo `index.html` con doble clic (`file://`).
Hace falta un servidor local:

```bash
python3 -m http.server 8000
```

Y abrir <http://localhost:8000>.

## Publicar en GitHub Pages

1. Subir los cambios a `main`:

   ```bash
   git add .
   git commit -m "feat: descripción del cambio"
   git push
   ```

2. En GitHub: **Settings → Pages → Build and deployment**.
3. En **Source** elegir **Deploy from a branch**, rama `main`, carpeta `/ (root)`, y guardar.
4. A los 1-2 minutos la página queda en <https://hernanibarra60.github.io/ThreeDetection/>.

Cada `git push` a `main` vuelve a publicar la página automáticamente.

## Estructura

```
index.html              Secciones de la página
css/styles.css          Estilos
js/main.js              Punto de entrada
js/scene/forest.js      Escena 3D: cielo, luces, suelo, pasto y ubicación de árboles
js/scene/tree.js        Generador procedural de árboles y viento
js/demo/camera.js       Manejo de la webcam
js/demo/segmenter.js    Interfaz del modelo (versión simulada)
js/demo/demo.js         Lógica de la demo
```
