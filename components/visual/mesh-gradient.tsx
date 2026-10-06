"use client";

import * as React from "react";
import { cn } from "@/lib/ui/cn";

/**
 * Animated mesh-gradient background (owner brief 2026-10-06 §34–37) — one WebGL canvas, no library.
 *
 * - One full-screen triangle (-1,-1 · 3,-1 · -1,3); the vertex shader passes the position through.
 * - Domain-warped FBM (5 octaves, frequency ×2.02, amplitude ×0.5):
 *     q = (fbm(p + orb), fbm(p + orb.yx + 3.1))
 *     r = (fbm(p + 2q + orb·1.3 + 1.7), fbm(p + 2q − orb + 9.2))
 *     f = fbm(p + 1.8r)
 * - Seamless: time never grows without bound. `u_t` runs once round the circle per loop and the only thing that moves
 *   is `orb = (cos u_t, sin u_t) · 0.55`, so the last frame of a loop is exactly the first.
 * - Eased pointer parallax shifts `p`, not time, so it can never break the loop.
 * - Dithered (±½ of a colour step) against banding; devicePixelRatio capped at 1.5.
 * - Paused while off screen or in a hidden tab. Under prefers-reduced-motion one still frame is drawn.
 * - Without WebGL the CSS gradient underneath is all there is — the page never goes blank.
 */

export type MeshPalette = readonly [string, string, string, string];

export const MESH_PALETTES = {
  FLOW: ["#06120d", "#123d2a", "#2015eb", "#41e012"],
  NOIR: ["#08090b", "#2f3237", "#8b9099", "#f3f4f6"],
  MINT: ["#f7f4e8", "#dcecd9", "#9ccfb2", "#5c9c85"],
  PLUM: ["#180814", "#48103e", "#95275f", "#e07a9c"],
  NEON: ["#04060a", "#7dff4d", "#ff2f92", "#29e6ff"],
} as const satisfies Record<string, MeshPalette>;
export type MeshPaletteName = keyof typeof MESH_PALETTES;

const VERTEX = `attribute vec2 a_pos; void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAGMENT = `precision highp float;
uniform vec2 u_res;
uniform float u_t;
uniform vec2 u_pointer;
uniform vec3 u_c0; uniform vec3 u_c1; uniform vec3 u_c2; uniform vec3 u_c3;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y) * 1.6 + u_pointer * 0.25;
  vec2 orb = vec2(cos(u_t), sin(u_t)) * 0.55;
  vec2 q = vec2(fbm(p + orb), fbm(p + orb.yx + 3.1));
  vec2 r = vec2(fbm(p + 2.0 * q + orb * 1.3 + 1.7), fbm(p + 2.0 * q - orb + 9.2));
  float f = fbm(p + 1.8 * r);
  vec3 col = mix(u_c0, u_c1, smoothstep(0.15, 0.55, f));
  col = mix(col, u_c2, smoothstep(0.45, 0.85, length(q)) * 0.75);
  col = mix(col, u_c3, smoothstep(0.62, 0.95, r.x * f) * 0.6);
  col *= 0.88 + 0.12 * (1.0 - length(uv - 0.5));
  col += (hash(gl_FragCoord.xy + fract(u_t)) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** Seconds for one full loop. */
const LOOP_SECONDS = 28;
/**
 * The field is soft, low-frequency noise, so it is drawn at half the (capped) pixel density and upscaled by the
 * browser — indistinguishable, at a quarter of the fragment work — and at most ~30 frames a second.
 */
const RENDER_SCALE = 0.5;
const FRAME_MS = 1000 / 30;

export function MeshGradient({ palette, className }: { palette: MeshPalette; className?: string }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false, powerPreference: "low-power" });
    if (!gl) {
      setFailed(true);
      return;
    }
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) {
      setFailed(true);
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setFailed(true);
      return;
    }
    gl.useProgram(program);

    // One triangle that covers the whole viewport.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const u = (name: string) => gl.getUniformLocation(program, name);
    const [uRes, uT, uPointer] = [u("u_res"), u("u_t"), u("u_pointer")];
    palette.forEach((hex, i) => gl.uniform3fv(u(`u_c${i}`), rgb(hex)));

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    let frame = 0;
    let visible = true;
    const start = performance.now();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * RENDER_SCALE;
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
      gl.uniform2f(uRes, width, height);
    };

    const draw = (now: number) => {
      resize();
      const t = (((now - start) / 1000) % LOOP_SECONDS) / LOOP_SECONDS;
      gl.uniform1f(uT, reduced ? 0.6 : t * Math.PI * 2);
      pointer.x += (pointer.tx - pointer.x) * 0.04;
      pointer.y += (pointer.ty - pointer.y) * 0.04;
      gl.uniform2f(uPointer, pointer.x, pointer.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    let last = 0;
    const loop = (now: number) => {
      if (now - last >= FRAME_MS) {
        last = now;
        draw(now);
      }
      frame = !reduced && visible && !document.hidden ? requestAnimationFrame(loop) : 0;
    };
    const resume = () => {
      if (!frame && !reduced && visible && !document.hidden) frame = requestAnimationFrame(loop);
    };
    const onPointer = (event: PointerEvent) => {
      pointer.tx = event.clientX / window.innerWidth - 0.5;
      pointer.ty = 0.5 - event.clientY / window.innerHeight;
    };

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      resume();
    });
    io.observe(canvas);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("resize", resume);
    if (reduced) draw(performance.now());
    else frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      io.disconnect();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("resize", resume);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [palette]);

  return (
    <div aria-hidden className={cn("pointer-events-none overflow-hidden", className)} style={{ background: `linear-gradient(135deg, ${palette[0]} 0%, ${palette[1]} 45%, ${palette[2]} 80%, ${palette[3]} 100%)` }}>
      {!failed && <canvas ref={canvasRef} className="h-full w-full" />}
    </div>
  );
}
