# ThreeDetection

Proyecto final de la cátedra de Inteligencia Artificial (FIUNA, 2026) de **Hernán Ibarra**,
estudiante de Ingeniería Mecatrónica.

- **Demo en vivo:** <https://hernanibarra60.github.io/ThreeDetection/>
- **CV personal:** <https://hernanibarra60.github.io/ThreeDetection/cv.html>

## De qué se trata

Contar naranjas a mano en el árbol es lento, y muchas frutas quedan tapadas por hojas. ThreeDetection
usa **segmentación de instancias** con **YOLO26n-seg**: encuentra cada naranja, dibuja su contorno, la
cuenta y estima a qué distancia está de la cámara. Todo corre en el navegador con una webcam común.

Resultados principales (test de 100 imágenes y 390 naranjas):

| Modelo | Máscara mAP50-95 | Error medio de conteo |
|---|---|---|
| YOLO26n-seg sin entrenar (COCO) | 0,42 | 1,65 naranjas por imagen |
| YOLO26n-seg con fine-tuning en dos etapas (el de la web) | 0,65 | **1,08** naranjas por imagen |

También se compararon YOLOv8n, YOLO11n y YOLO26n con la misma receta y 3 semillas: empatan en
calidad de máscara (~0,67 de mAP50-95), y YOLO11 y YOLO26 cuentan un 18 % mejor que YOLOv8. La
medición de distancia con la Logitech C270 tuvo un error medio de ~2,8 cm entre 30 cm y 1 m.

## Qué incluye la página

- **Naranjal 3D** generado proceduralmente con [three.js](https://threejs.org/) (naranjos con frutas, pasto y viento).
- **Demo de segmentación** con la webcam o subiendo una imagen: marca cada naranja, las cuenta y calcula la cobertura.
- **Medición de distancia y volumen** de cada naranja con una sola cámara, con el modelo geométrico de AGRO-YOLO-V.
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

## Medición de distancia y volumen

Se adapta el modelo geométrico de AGRO-YOLO-V: *Sukkuea et al., IEEE Access, 2026,
DOI [10.1109/ACCESS.2026.3667161](https://doi.org/10.1109/ACCESS.2026.3667161)*. El código está en
[`js/demo/geometry.js`](js/demo/geometry.js) y se activa en el bloque **Medición** de la demo.

Para cada naranja segmentada:

- **Área proyectada**, como en el paper: envolvente convexa de la máscara y fórmula del cordón de
  zapato, `A` en píxeles². Como la envolvente pasa por los centros de los píxeles extremos, se le
  suma un borde de 0,3 px (`0,3·perímetro + π·0,3²`), calibrado con discos digitales: sin él, una
  naranja de 10 px de radio mide un 4 % menos. Radio aparente: `r = √(A / π)`.
- **Distancia focal**: `f = (W / 2) / tan(FOV_h / 2)`, con `W` el ancho de la máscara. Se guarda
  normalizada como `f / W` para que no dependa de la resolución. La calibración la reemplaza.
- **Modo distancia** (diámetro supuesto `D`, por defecto 75 mm): `Z = (D / 2)·√(1 + (f / r)²)`,
  la distancia de la cámara al centro de una esfera cuya silueta mide `r`.
- **Modo tamaño y volumen** (distancia fija `Z`, como la cinta transportadora del paper):
  `V = k·A^(3/2)` con `k = 4 / (3√π)·(Z / f)³` (ecuaciones 1 y 3 del paper) y
  `D = 2Z·sen(arctan(r / f))`.
- Las naranjas que tocan el borde de la imagen tienen el área truncada: se marcan con «?».

**Calibrar:** poné una naranja entera frente a la cámara, medí la distancia de la lente a su centro
y tocá **Calibrar**. Con el diámetro del campo (75 mm por defecto) se despeja
`f / W = r·√((Z / R)² − 1) / W`, que se guarda en el navegador (`localStorage`). Mientras haya
calibración, el campo de visión muestra el equivalente y no se puede editar; **Restablecer** la
borra. La calibración vale para esa cámara y esa resolución: el zoom o un recorte la invalidan, y
las fotos subidas de otra cámara necesitan su propio campo de visión.

**Validación:** [`validacion.html`](validacion.html) (enlazada desde la demo) recorre un naranjo 3D
con una cámara virtual a distancias y ángulos conocidos, pasa cada captura por el mismo modelo y
compara con la posición y el tamaño reales de cada fruta: porcentaje de mediciones válidas, MAE,
RMSE y error porcentual por rango de distancia, al estilo de Coll-Ribes et al. La distancia se
mide con la focal exacta de la cámara virtual y con la de un campo de visión supuesto; el volumen,
con la distancia real. La escala se fija para que el diámetro medio de las frutas equivalga a
75 mm. Se puede descargar el detalle por fruta en CSV.

**Limitaciones:**

- En modo distancia el diámetro supuesto hereda la variabilidad de tamaño de las naranjas: una
  fruta un 10 % más grande que el supuesto parece un 10 % más cerca.
- La oclusión (hojas, otras naranjas) achica el área visible y hace que la naranja parezca más
  lejos. La envolvente convexa compensa los huecos, pero no las partes tapadas en el borde.
- Fuera del eje óptico la silueta de una esfera es una elipse más grande que en el centro: las
  naranjas en las esquinas de un gran angular parecen algo más cerca.
- En la simulación por color, naranjas que se tocan forman una sola mancha.

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
js/demo/model.worker.js Inferencia en un Web Worker: máscara y estadísticas por naranja
js/demo/geometry.js     Modelo geométrico: envolvente convexa, distancia, tamaño y volumen
js/demo/demo.js         Lógica de la demo
validacion.html         Validación de la medición con el naranjal 3D
js/validation/benchmark.js  Barrido de la cámara virtual y métricas
```
