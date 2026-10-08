// A tiny voxel donkey, rasterized into colored braille. No assets, subprocesses,
// model calls, or dependency on Pi internals. Geometry is built once per process.
export const RIBBON_COLORS = [203, 214, 220, 78, 81, 141];
const PAPER = [203, 214, 220, 78, 81, 141];
const INK = 235;
const CREAM = 230;
const voxels = new Map();
const key = (x, y, z) => `${x},${y},${z}`;
const fringe = (y) => PAPER[((Math.floor(y / 2) % PAPER.length) + PAPER.length) % PAPER.length];

function ellipsoid(cx, cy, cz, rx, ry, rz, color = (_, y) => fringe(y)) {
  for (let x = Math.floor(cx - rx); x <= cx + rx; x++)
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
      for (let z = Math.floor(cz - rz); z <= cz + rz; z++)
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 <= 1)
          voxels.set(key(x, y, z), { x, y, z, color: color(x, y, z) });
}

// Four purple-hoofed legs, a round rainbow body, neck, muzzle, tall ears, and tail.
for (const x of [-3, 6])
  for (const z of [-2, 2]) ellipsoid(x, 7, z, 1.4, 5, 1.1, (_, y) => (y >= 10 ? 99 : fringe(y)));
ellipsoid(1, 2, 0, 8, 4.5, 3.5);
ellipsoid(-5, -1, 0, 3, 5, 2.7);
ellipsoid(-7, -4, 0, 4, 3.5, 3);
ellipsoid(-6, -9, -1.5, 1.1, 5, 1, (_, y) => (y < -10 ? 141 : 81));
ellipsoid(-3.5, -9, 1, 1.1, 5, 1, (_, y) => (y < -10 ? 203 : 220));
ellipsoid(-10, -2.5, 0, 3, 2, 2.9, () => CREAM);
ellipsoid(9, 1, 0, 3, 0.8, 0.8, () => 214);
ellipsoid(11, 3, 0, 1.5, 3, 1.4);
for (const z of [-3, 3]) {
  for (const [x, y, c] of [
    [-8, -5, CREAM],
    [-8, -4, INK],
    [-7, -5, INK],
    [-11, -2, 137],
    [-10, -1, 137],
  ])
    voxels.set(key(x, y, z), { x, y, z, color: c });
}

const sides = [
  {
    n: [1, 0, 0],
    corners: [
      [0.5, -0.5, -0.5],
      [0.5, 0.5, -0.5],
      [0.5, 0.5, 0.5],
      [0.5, -0.5, 0.5],
    ],
  },
  {
    n: [-1, 0, 0],
    corners: [
      [-0.5, -0.5, 0.5],
      [-0.5, 0.5, 0.5],
      [-0.5, 0.5, -0.5],
      [-0.5, -0.5, -0.5],
    ],
  },
  {
    n: [0, 1, 0],
    corners: [
      [-0.5, 0.5, -0.5],
      [-0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.5, 0.5, -0.5],
    ],
  },
  {
    n: [0, -1, 0],
    corners: [
      [-0.5, -0.5, 0.5],
      [-0.5, -0.5, -0.5],
      [0.5, -0.5, -0.5],
      [0.5, -0.5, 0.5],
    ],
  },
  {
    n: [0, 0, 1],
    corners: [
      [-0.5, -0.5, 0.5],
      [0.5, -0.5, 0.5],
      [0.5, 0.5, 0.5],
      [-0.5, 0.5, 0.5],
    ],
  },
  {
    n: [0, 0, -1],
    corners: [
      [0.5, -0.5, -0.5],
      [-0.5, -0.5, -0.5],
      [-0.5, 0.5, -0.5],
      [0.5, 0.5, -0.5],
    ],
  },
];
const faces = [];
for (const { x, y, z, color } of voxels.values())
  for (const { n, corners } of sides)
    if (!voxels.has(key(x + n[0], y + n[1], z + n[2])))
      faces.push({ color, normal: n, points: corners.map(([a, b, c]) => [x + a, y + b, z + c]) });

// A fixed light gives the paper facets depth even when the mascot is still.
const shadeCache = new Map();
function shaded(color, light) {
  if (color < 16 || color >= 232) return color;
  const level = Math.round(light * 6);
  const id = color * 10 + level;
  if (shadeCache.has(id)) return shadeCache.get(id);
  const n = color - 16;
  const cube = [0, 95, 135, 175, 215, 255];
  const channels = [Math.floor(n / 36), Math.floor(n / 6) % 6, n % 6].map((v) => {
    const target = (cube[v] * level) / 6;
    return cube.reduce(
      (best, value, i) => (Math.abs(value - target) < Math.abs(cube[best] - target) ? i : best),
      0,
    );
  });
  const value = 16 + channels[0] * 36 + channels[1] * 6 + channels[2];
  shadeCache.set(id, value);
  return value;
}

export function colorize(color, value, colors = !process.env.NO_COLOR) {
  return colors ? `\x1b[38;5;${color}m${value}\x1b[39m` : value;
}

export function mood(run) {
  if (!run) return { kind: "idle", text: "Ready when you are." };
  if (["verification_failed", "rolled_back"].includes(run.integration))
    return { kind: "attention", text: `Integration ${run.integration.replaceAll("_", " ")}.` };
  if (
    run.state === "cost limit reached" ||
    run.tasks.some((t) => ["failed", "rejected", "uncertain", "blocked"].includes(t.status))
  )
    return { kind: "attention", text: "Something needs a closer look." };
  if (run.state === "cancelled" || run.state === "cancelling")
    return {
      kind: "idle",
      text: run.state === "cancelled" ? "Taking a breather. Run cancelled." : "Winding down…",
    };
  if (run.tasks.length && run.tasks.every((t) => t.status === "succeeded")) {
    if (run.tasks.some((t) => t.role === "builder") && run.integration !== "verified")
      return { kind: "ready", text: "Reviews complete. Waiting for integration." };
    return {
      kind: "success",
      text:
        run.integration === "verified"
          ? "Checks passed. Changes integrated. ¡Fiesta!"
          : "All agents home. ¡Fiesta!",
    };
  }
  if (
    run.tasks.some(
      (t) => t.role === "reviewer" && !["queued", "succeeded", "cancelled"].includes(t.status),
    )
  )
    return { kind: "review", text: "A second pair of eyes…" };
  return {
    kind: "working",
    text: run.tasks.some((t) => t.status !== "queued")
      ? "A little teamwork. A little paper magic."
      : "Gathering the crew…",
  };
}

const DOTS = [
  [1, 8],
  [2, 16],
  [4, 32],
  [64, 128],
];
const edge = (a, b, x, y) => (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);

export function mascotFrame({
  width = 44,
  height = 18,
  seconds = 0,
  bonk = Infinity,
  cheer = Infinity,
  twitch = Infinity,
  kind = "working",
  tasks = [],
  colors = true,
} = {}) {
  width = Math.max(1, Math.min(72, Math.floor(width)));
  height = Math.max(1, Math.min(26, Math.floor(height)));
  const w = width * 2,
    h = height * 4;
  const depth = new Float32Array(w * h).fill(Infinity);
  const pixels = new Int16Array(w * h).fill(-1);
  const swing = bonk < 2 ? Math.sin(bonk * 13) * Math.exp(-bonk * 2.2) * 0.45 : 0;
  const calm = kind === "attention" || kind === "idle";
  const yaw = calm ? -0.3 : -0.3 + seconds * 0.32;
  const roll = swing + (kind === "attention" ? -0.13 : Math.sin(seconds * 1.6) * 0.035);
  const scale = Math.min(w / 36, h / 34);
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw),
    cr = Math.cos(roll),
    sr = Math.sin(roll);
  function project([x, y, z]) {
    if (y < -7 && twitch < 0.9) x += Math.sin(twitch * 20) * (y + 7) * 0.06;
    const a = x * cy + z * sy,
      b = z * cy - x * sy;
    const yy = y * 0.992 - b * 0.126,
      zz = b * 0.992 + y * 0.126;
    const perspective = 65 / (65 + zz);
    return [
      w / 2 + (a * cr - yy * sr) * scale * perspective,
      h / 2 + (a * sr + yy * cr) * scale * perspective,
      zz,
    ];
  }
  function dot(x, y, z, color) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = y * w + x;
    if (z < depth[i]) {
      depth[i] = z;
      pixels[i] = color;
    }
  }
  function triangle(a, b, c, color) {
    const area = edge(a, b, c[0], c[1]);
    if (Math.abs(area) < 0.001) return;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))),
      x1 = Math.min(w - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))),
      y1 = Math.min(h - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const aa = edge(b, c, x, y) / area,
          bb = edge(c, a, x, y) / area,
          cc = 1 - aa - bb;
        if (aa >= 0 && bb >= 0 && cc >= 0) dot(x, y, aa * a[2] + bb * b[2] + cc * c[2], color);
      }
  }
  // The string stays attached to the back as the donkey swings.
  const anchor = project([0, -2, 0]);
  for (let y = 0; y < anchor[1]; y++)
    dot(w / 2 + ((anchor[0] - w / 2) * y) / anchor[1], y, 20, 245);
  for (const face of faces) {
    const [a, b, c, d] = face.points.map(project);
    const [nx, ny, nz] = face.normal;
    const light = 0.67 + Math.max(0, -(nz * cy - nx * sy) * 0.25 - ny * 0.3);
    const color = shaded(face.color, light);
    triangle(a, b, c, color);
    triangle(a, c, d, color);
  }
  // One paper ribbon per task. Finished ribbons rest; active ribbons flutter.
  tasks.slice(0, 12).forEach((task, i) => {
    const settled = [
      "succeeded",
      "failed",
      "rejected",
      "blocked",
      "uncertain",
      "cancelled",
    ].includes(task.status);
    const side = i % 2 ? 1 : -1,
      slot = Math.floor(i / 2);
    for (let j = 0; j < 9; j++) {
      const wave = settled || calm ? 0 : Math.sin(seconds * 4 + i + j / 3) * 2;
      dot(
        w / 2 + side * (w * 0.38 - slot * 3) + wave,
        h * 0.65 + slot * 4 + j,
        -30,
        RIBBON_COLORS[i % 6],
      );
    }
  });
  const burst = cheer < 3.5 ? cheer : bonk < 1.4 ? bonk : null;
  if (burst !== null) {
    const count = cheer < 3.5 ? 65 : 12;
    for (let i = 0; i < count; i++) {
      const angle = i * 2.399,
        speed = 9 + (i % 7) * 3;
      const x = w / 2 + Math.cos(angle) * speed * burst;
      const y = h / 2 + Math.sin(angle) * speed * burst + burst * burst * 10;
      dot(x, y, -50, PAPER[i % 6]);
      dot(x + 1, y, -50, PAPER[i % 6]);
    }
  }
  const lines = [];
  for (let row = 0; row < height; row++) {
    let line = "",
      previous = -1;
    for (let col = 0; col < width; col++) {
      let bits = 0,
        color = -1,
        nearest = Infinity;
      for (let yy = 0; yy < 4; yy++)
        for (let xx = 0; xx < 2; xx++) {
          const i = (row * 4 + yy) * w + col * 2 + xx;
          if (pixels[i] < 0) continue;
          bits |= DOTS[yy][xx];
          if (depth[i] < nearest) {
            nearest = depth[i];
            color = pixels[i];
          }
        }
      if (colors && bits && color !== previous) {
        line += `\x1b[38;5;${color}m`;
        previous = color;
      }
      line += bits ? String.fromCharCode(0x2800 + bits) : " ";
    }
    lines.push(line + (colors && previous !== -1 ? "\x1b[39m" : ""));
  }
  return lines;
}
