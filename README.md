# ThreeDetection

Página web del proyecto de la cátedra de Inteligencia Artificial. Por ahora el foco es la
**segmentación de naranjas** con YOLO26n-seg.

- **Naranjal 3D** generado proceduralmente con [three.js](https://threejs.org/) (naranjos con frutas, pasto y viento).
- **Demo de segmentación** con la webcam o subiendo una imagen: marca cada naranja, las cuenta y calcula la cobertura.
- El modelo corre **en el navegador** con [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/): las imágenes no se suben a ningún servidor.
- Sitio estático: HTML, CSS y JavaScript, sin paso de build.

## Modelo

El notebook [`naranjas.ipynb`](naranjas.ipynb) se corre en Google Colab (GPU T4). Evalúa YOLO26n-seg
preentrenado en COCO (clase 49, *orange*) sobre el dataset *Orange occlusion* de Roboflow, y exporta
el modelo a ONNX. También trae preparadas las secciones de transfer learning y fine-tuning
(`ENTRENAR = False`).

Al terminar, el notebook deja en Google Drive:

```
MyDrive/naranjas/
  web/orange-seg.onnx          Modelo base exportado (~11 MB)
  web/model.json               Tamaño de entrada, clase a usar, umbral y salidas del modelo
  web_finetune/...             Lo mismo para el modelo ajustado (solo si ENTRENAR = True)
  metricas_base.csv            mAP, precisión y recall del modelo base
  conteo_base.csv              Naranjas predichas vs. reales en cada imagen de test
  runs/                        Gráficos de validación y entrenamientos
```

Para usarlo en la web, descargá `orange-seg.onnx` y `model.json` de la carpeta `web/`
(o `web_finetune/`) y copialos en `model/`:

```
ThreeDetection/
  model/
    orange-seg.onnx
    model.json
```

**Modo simulado:** si `model/` no existe o falta algún archivo, la demo no se rompe. Aproxima la
máscara detectando los píxeles de color naranja (HSV) y lo avisa en pantalla. Así se puede trabajar
en la página antes de exportar el modelo.

La primera carga del modelo descarga unos 25 MB (el `.onnx` y el runtime de WebAssembly). Después
el navegador los guarda en caché.

## Correr en local

Los módulos ES y la cámara no funcionan abriendo `index.html` con doble clic (`file://`).
Hace falta un servidor local:

```bash
python3 -m http.server 8000
```

Y abrir <http://localhost:8000>. Para comparar con el notebook, subí una imagen del split de test
y compará el conteo con `conteo_base.csv`.

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
naranjas.ipynb          Notebook de Colab: evaluación, exportación a ONNX y fine-tuning
model/                  orange-seg.onnx y model.json (se copian desde Drive)
css/styles.css          Estilos
js/main.js              Punto de entrada
js/scene/forest.js      Escena 3D: cielo, luces, suelo, pasto e hileras del naranjal
js/scene/tree.js        Generador procedural de árboles (naranjo con frutas) y viento
js/demo/camera.js       Manejo de la webcam
js/demo/segmenter.js    Modelo: YOLO26n-seg con ONNX Runtime Web, o simulación por color
js/demo/demo.js         Lógica de la demo
```
