import { initForest } from './scene/forest.js';
import { initDemo } from './demo/demo.js';

initDemo();

// La generación del bosque bloquea unos milisegundos: se difiere para que la página pinte primero.
requestAnimationFrame(() => {
  setTimeout(() => {
    initForest(document.getElementById('forest-canvas'), document.getElementById('hero'));
  }, 0);
});
