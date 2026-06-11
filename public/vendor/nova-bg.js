/* Nova ambient background — the same 3D world on every page.
   Neon grid + drifting particle fields, rendered behind the UI.
   Cheap on purpose: capped pixel ratio, no meshes, slow autonomous
   camera drift (works on kiosks with no pointer). Falls back to the
   page gradient if WebGL is unavailable; renders a single still
   frame for reduced-motion users. */
(function () {
  if (!window.THREE) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const canvas = document.createElement('canvas');
  canvas.id = 'novabg';
  const dim = parseFloat(document.currentScript && document.currentScript.dataset.dim) || .8;
  canvas.style.opacity = dim;
  document.body.prepend(canvas);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) { canvas.remove(); return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x050510, 8, 34);
  const cam = new THREE.PerspectiveCamera(55, 1, .1, 100);
  cam.position.set(0, 1.4, 9);

  const grid = new THREE.GridHelper(170, 90, 0x1d3fae, 0x0d0f2e);
  grid.position.y = -2.1;
  scene.add(grid);

  function stars(n, color, size, spread) {
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i += 3) {
      pos[i] = (Math.random() - .5) * spread;
      pos[i + 1] = Math.random() * 13 - 1.5;
      pos[i + 2] = (Math.random() - .5) * spread;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({
      color, size, transparent: true, opacity: .7,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    scene.add(p);
    return p;
  }
  const dust1 = stars(320, 0x4f8cff, .07, 58);
  const dust2 = stars(200, 0xb07aff, .055, 50);

  function resize() {
    renderer.setSize(innerWidth, innerHeight, false);
    cam.aspect = innerWidth / innerHeight;
    cam.updateProjectionMatrix();
  }
  addEventListener('resize', resize); resize();

  const clock = new THREE.Clock();
  function frame() {
    const t = clock.getElapsedTime();
    grid.position.z = (t * 1.7) % 1.889;
    dust1.rotation.y = t * .01;
    dust2.rotation.y = -t * .014;
    cam.position.x = Math.sin(t * .07) * .7;       // slow autonomous drift
    cam.position.y = 1.4 + Math.sin(t * .11) * .15;
    cam.lookAt(0, .4, 0);
    renderer.render(scene, cam);
    if (!reduced) requestAnimationFrame(frame);
  }
  frame();
})();
