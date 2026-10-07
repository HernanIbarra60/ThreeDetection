import * as THREE from 'three';
import { createTree, createRng, NORMAL_NO_FLIP } from './tree.js';

const SKY_TOP = new THREE.Color(0x86b9de);
const HORIZON = new THREE.Color(0xe6ecdc);
const SUN_DIRECTION = new THREE.Vector3(25, 35, 18).normalize();

const CAMERA_TARGET = new THREE.Vector3(2, 5.2, 0);

/* [tipo, x, z, detalle, semilla]: el árbol principal queda a la derecha, detrás del texto hay espacio. */
const TREE_LAYOUT = [
  ['broadleaf', 6.5, -1, 1, 3],
  ['broadleaf', -9, -8, 1, 17],
  ['conifer', 13, -9, 1, 5],
  ['conifer', -19, -22, 1, 9],
  ['broadleaf', 1.5, -24, 0.6, 21],
  ['conifer', -16, -20, 0.6, 33],
  ['conifer', 21, -21, 0.6, 41],
  ['broadleaf', -23, -11, 0.6, 52],
  ['conifer', 9, -31, 0.6, 61],
  ['broadleaf', -8, -35, 0.6, 77],
  ['conifer', 28, -36, 0.6, 85],
  ['conifer', -29, -31, 0.6, 93],
];

function groundHeight(x, z) {
  const distance = Math.hypot(x, z + 10);
  const hills = Math.sin(x * 0.045) * Math.cos(z * 0.06) * 2.4 + Math.sin(x * 0.11 + z * 0.07) * 0.7;
  const fade = THREE.MathUtils.smoothstep(distance, 18, 60);
  return hills * fade + Math.sin(x * 0.3) * Math.cos(z * 0.25) * 0.08;
}

function createSky() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: SKY_TOP },
      uHorizon: { value: HORIZON },
      uSun: { value: SUN_DIRECTION },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uSun;
      varying vec3 vDirection;
      void main() {
        float h = max(vDirection.y, 0.0);
        vec3 color = mix(uHorizon, uTop, smoothstep(0.0, 0.55, h));
        float sun = max(dot(normalize(vDirection), uSun), 0.0);
        color += vec3(1.0, 0.86, 0.6) * (pow(sun, 8.0) * 0.25 + pow(sun, 200.0) * 0.8);
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), material);
  sky.renderOrder = -1;
  return sky;
}

function grassTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const rng = createRng(101);
  ctx.fillStyle = '#6d8c45';
  ctx.fillRect(0, 0, 256, 256);
  const palette = ['#5b7a38', '#7f9d4f', '#8daa58', '#4f6c31', '#9a9a5a', '#6e7f3c'];
  for (let i = 0; i < 2600; i++) {
    const x = rng() * 256;
    const y = rng() * 256;
    ctx.strokeStyle = palette[Math.floor(rng() * palette.length)];
    ctx.globalAlpha = 0.5 + rng() * 0.5;
    ctx.lineWidth = 1 + rng() * 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng() - 0.5) * 6, y - 4 - rng() * 8);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(60, 60);
  texture.anisotropy = 8;
  return texture;
}

function createGround() {
  const geometry = new THREE.PlaneGeometry(260, 260, 160, 160);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    position.setY(i, groundHeight(position.getX(i), position.getZ(i)));
  }
  geometry.computeVertexNormals();

  const ground = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0xc9d6a8, map: grassTexture(), roughness: 1 }),
  );
  ground.receiveShadow = true;
  return ground;
}

function createGrass(count, wind) {
  const segments = 4;
  const geometry = new THREE.BufferGeometry();
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  const baseColor = new THREE.Color(0x3d5a26);
  const tipColor = new THREE.Color(0xb4c97a);
  const c = new THREE.Color();

  for (let i = 0; i <= segments; i++) {
    const s = i / segments;
    const halfWidth = 0.035 * (1 - s * 0.9);
    const bendZ = s * s * 0.12;
    positions.push(-halfWidth, s, bendZ, halfWidth, s, bendZ);
    normals.push(0, 1, 0.3, 0, 1, 0.3);
    c.lerpColors(baseColor, tipColor, s);
    colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    if (i < segments) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);

  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = wind.uTime;
    shader.uniforms.uWind = wind.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
      .replace('#include <project_vertex>', /* glsl */ `
        float bladeHeight = transformed.y;
        vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0);
        float wave = sin(uTime * 1.6 + mvPosition.x * 0.35 + mvPosition.z * 0.25) * 0.6
                   + sin(uTime * 2.9 + mvPosition.x * 1.3 + mvPosition.z * 0.8) * 0.25;
        mvPosition.x += wave * bladeHeight * bladeHeight * uWind * 0.9;
        mvPosition.z += wave * bladeHeight * bladeHeight * uWind * 0.3;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
      `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', NORMAL_NO_FLIP);
  };
  material.customProgramCacheKey = () => 'grass-wind';

  const grass = new THREE.InstancedMesh(geometry, material, count);
  const rng = createRng(202);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const tint = new THREE.Color();

  for (let i = 0; i < count; i++) {
    // Más densidad cerca de la cámara, donde se nota el detalle.
    const near = rng() < 0.55;
    pos.x = (rng() - 0.5) * (near ? 34 : 70);
    pos.z = near ? -6 + rng() * 18 : -40 + rng() * 34;
    pos.y = groundHeight(pos.x, pos.z);
    euler.set((rng() - 0.5) * 0.3, rng() * Math.PI * 2, (rng() - 0.5) * 0.3);
    quaternion.setFromEuler(euler);
    const h = 0.3 + rng() * 0.5;
    scale.set(1 + rng() * 0.8, h, 1);
    matrix.compose(pos, quaternion, scale);
    grass.setMatrixAt(i, matrix);
    tint.setHSL(0.22 + (rng() - 0.5) * 0.06, 0.35 + rng() * 0.2, 0.55 + rng() * 0.25);
    grass.setColorAt(i, tint);
  }
  grass.instanceMatrix.needsUpdate = true;
  grass.computeBoundingSphere();
  grass.receiveShadow = true;
  return grass;
}

function createRocks() {
  const group = new THREE.Group();
  const rng = createRng(303);
  const material = new THREE.MeshStandardMaterial({ color: 0x8f8a7c, roughness: 0.9, flatShading: true });
  const spots = [[3.5, 2.5], [9, 1], [-5, -2], [-12, -4], [15, -4], [0, -10]];
  for (const [x, z] of spots) {
    const geometry = new THREE.DodecahedronGeometry(1, 1);
    const p = geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const f = 0.75 + rng() * 0.4;
      p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.6, p.getZ(i) * f);
    }
    geometry.computeVertexNormals();
    const rock = new THREE.Mesh(geometry, material);
    const s = 0.3 + rng() * 0.5;
    rock.scale.setScalar(s);
    rock.position.set(x, groundHeight(x, z) + s * 0.15, z);
    rock.rotation.y = rng() * Math.PI;
    rock.castShadow = true;
    rock.receiveShadow = true;
    group.add(rock);
  }
  return group;
}

function createPollen(count) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255, 250, 225, 1)');
  gradient.addColorStop(1, 'rgba(255, 250, 225, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const sprite = new THREE.CanvasTexture(canvas);

  const rng = createRng(404);
  const base = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    base[i * 3] = (rng() - 0.5) * 36;
    base[i * 3 + 1] = 0.5 + rng() * 9;
    base[i * 3 + 2] = -14 + rng() * 26;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3));

  const points = new THREE.Points(geometry, new THREE.PointsMaterial({
    size: 0.09,
    map: sprite,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  }));

  points.userData.update = (time) => {
    const attr = geometry.attributes.position;
    for (let i = 0; i < count; i++) {
      const phase = i * 1.37;
      attr.array[i * 3] = base[i * 3] + Math.sin(time * 0.3 + phase) * 0.6;
      attr.array[i * 3 + 1] = base[i * 3 + 1] + Math.sin(time * 0.5 + phase * 2.1) * 0.3;
      attr.array[i * 3 + 2] = base[i * 3 + 2] + Math.cos(time * 0.25 + phase) * 0.4;
    }
    attr.needsUpdate = true;
  };
  return points;
}

/**
 * Crea la escena del bosque dentro del canvas y la anima mientras el contenedor esté visible.
 * Devuelve null si el navegador no soporta WebGL (el CSS muestra un degradado de respaldo).
 */
export function initForest(canvas, container) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (error) {
    console.warn('WebGL no disponible, se omite la escena 3D.', error);
    return null;
  }

  const isSmallScreen = window.innerWidth < 700;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let pixelRatio = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Las sombras se recalculan cada pocos frames: el viento las mueve poco y ahorra mucho en GPUs integradas.
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(HORIZON, 28, 115);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);

  const wind = {
    uTime: { value: 0 },
    uWind: { value: reducedMotion ? 0.12 : 0.4 },
  };

  scene.add(createSky());
  scene.add(new THREE.HemisphereLight(0xdcefff, 0x5a4a32, 1.4));

  const sun = new THREE.DirectionalLight(0xfff0d8, 2.8);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(50);
  sun.target.position.set(0, 0, -6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(isSmallScreen ? 1024 : 2048, isSmallScreen ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 140 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  scene.add(createGround());
  scene.add(createGrass(isSmallScreen ? 8000 : 18000, wind));
  scene.add(createRocks());

  const layout = isSmallScreen ? TREE_LAYOUT.slice(0, 8) : TREE_LAYOUT;
  for (const [type, x, z, detail, seed] of layout) {
    const tree = createTree({ type, seed, detail, wind });
    tree.position.set(x, groundHeight(x, z) - 0.1, z);
    if (detail < 1) tree.traverse((obj) => { obj.castShadow = false; });
    scene.add(tree);
  }

  // Bosque de fondo, con menos detalle porque queda dentro de la niebla.
  const fillRng = createRng(505);
  const fillCount = isSmallScreen ? 6 : 16;
  for (let i = 0; i < fillCount; i++) {
    const x = (fillRng() - 0.5) * 110;
    const z = -45 - fillRng() * 35;
    const type = fillRng() < 0.6 ? 'conifer' : 'broadleaf';
    const tree = createTree({ type, seed: 1000 + i, detail: 0.5, wind });
    tree.position.set(x, groundHeight(x, z) - 0.1, z);
    tree.traverse((obj) => { obj.castShadow = false; });
    scene.add(tree);
  }

  const pollen = createPollen(isSmallScreen ? 120 : 260);
  scene.add(pollen);

  function resize() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    if (camera.aspect < 1) {
      camera.fov = 62;
      camera.position.set(3, 3.5, 25);
    } else {
      camera.fov = 50;
      camera.position.set(0, 3, 16);
    }
    camera.lookAt(CAMERA_TARGET);
    camera.updateProjectionMatrix();
  }

  const clock = new THREE.Clock();
  let elapsed = 0;
  let frame = 0;

  // Resolución adaptativa: si la GPU no llega a ~45 FPS, se baja el pixel ratio de a poco.
  let fpsFrames = 0;
  let fpsWindowStart = performance.now();
  function adaptQuality() {
    fpsFrames++;
    const now = performance.now();
    if (now - fpsWindowStart < 1500) return;
    const fps = (fpsFrames * 1000) / (now - fpsWindowStart);
    fpsFrames = 0;
    fpsWindowStart = now;
    if (fps < 45 && pixelRatio > 0.6) {
      pixelRatio = Math.max(0.6, pixelRatio * 0.8);
      renderer.setPixelRatio(pixelRatio);
      resize();
    }
  }

  function render() {
    elapsed += Math.min(clock.getDelta(), 0.1);
    wind.uTime.value = elapsed;
    pollen.userData.update(elapsed);
    if (frame % 3 === 0) renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    if (frame === 0) canvas.classList.add('is-ready');
    frame++;
    if (running) adaptQuality();
  }

  let running = false;
  function start() {
    if (running) return;
    running = true;
    clock.getDelta();
    fpsFrames = 0;
    fpsWindowStart = performance.now();
    renderer.setAnimationLoop(render);
  }
  function stop() {
    running = false;
    renderer.setAnimationLoop(null);
  }

  window.addEventListener('resize', () => {
    resize();
    if (!running) render();
  });
  resize();

  if (reducedMotion) {
    render();
  } else {
    new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop()), { threshold: 0 })
      .observe(container);
  }

  return { start, stop };
}
