// All art, anchors, and connectors share one SVG coordinate system.
// Each path follows the same offset as the artwork it connects to.
(() => {
  const stage = document.querySelector("#cloud-stage");
  const toggle = document.querySelector("#toggle-cloud-motion");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const nodes = [
    { id: "mascot", amplitude: 0, phase: 0 },
    { id: "cloud", amplitude: 7, phase: 0.8 },
    { id: "workspace-top", amplitude: 12, phase: 2.1 },
    { id: "workspace-bottom", amplitude: 9, phase: 4.2 },
    { id: "workspace-right", amplitude: 11, phase: 5.6 },
  ].map((node) => ({
    ...node,
    element: stage.querySelector(`#${node.id}`),
    x: 0,
    y: 0,
  }));
  const links = [
    { node: 0, start: [755, 418], end: [475, 490], bend: -45 },
    { node: 2, start: [1000, 360], end: [1165, 300], bend: -25 },
    { node: 3, start: [837, 440], end: [895, 754], bend: 70 },
    { node: 4, start: [940, 425], end: [1175, 650], bend: 30 },
  ].map((link, index) => ({
    ...link,
    paths: stage.querySelectorAll(`[data-link="${index}"]`),
    lights: stage.querySelectorAll(`[data-light="${index}"]`),
  }));
  let userPaused = false;
  let visible = false;
  let frame = 0;
  let previous = null;
  let elapsed = 0;

  function paint(time) {
    nodes.forEach((node) => {
      node.x = Math.sin(time * 0.32 + node.phase) * node.amplitude * 0.4;
      node.y = Math.sin(time * 0.48 + node.phase) * node.amplitude;
      node.element.setAttribute("transform", `translate(${node.x} ${node.y})`);
    });
    links.forEach((link, index) => {
      const cloud = nodes[1];
      const target = nodes[link.node];
      const a = [link.start[0] + cloud.x, link.start[1] + cloud.y];
      const d = [link.end[0] + target.x, link.end[1] + target.y];
      const b = [a[0], a[1] + (d[1] - a[1]) * 0.6 + link.bend];
      const c = [d[0], d[1] - (d[1] - a[1]) * 0.6 + link.bend];
      const path = `M ${a} C ${b} ${c} ${d}`;
      link.paths.forEach((element) => element.setAttribute("d", path));
      link.lights.forEach((light, i) => {
        const t = (time * 0.14 + index * 0.21 + i * 0.5) % 1;
        const u = 1 - t;
        const point = (axis) =>
          u ** 3 * a[axis] +
          3 * u ** 2 * t * b[axis] +
          3 * u * t ** 2 * c[axis] +
          t ** 3 * d[axis];
        light.setAttribute("cx", point(0));
        light.setAttribute("cy", point(1));
        light.setAttribute("opacity", Math.min(1, t * 8, (1 - t) * 8));
      });
    });
  }
  function tick(now) {
    if (previous !== null) elapsed += Math.min((now - previous) / 1000, 0.05);
    previous = now;
    paint(elapsed);
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    cancelAnimationFrame(frame);
    previous = null;
    const paused = userPaused || reduced.matches;
    toggle.hidden = reduced.matches;
    toggle.textContent = paused ? "Play animation" : "Pause animation";
    if (!paused && visible && !document.hidden)
      frame = requestAnimationFrame(tick);
  }
  toggle.addEventListener("click", () => {
    userPaused = !userPaused;
    sync();
  });
  reduced.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  }).observe(stage);
  paint(0);
  sync();
})();
