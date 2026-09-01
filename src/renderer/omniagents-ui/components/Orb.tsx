/**
 * The voice orb — a WebGL (ogl) shader blob whose whole personality lives
 * in its RAF loop.
 *
 * Mounted ONCE: the renderer effect has no reactive deps, so state flips
 * never tear down the GL context (the old modal recreated it on every
 * transition — the visible pop). Props land in refs; the RAF computes the
 * per-state parameter targets (scale, turbulence, speed, tool-overlay hue
 * cycling) from time + the mutable `levelSource` holder and eases the live
 * uniforms toward them — zero React re-renders at animation rate, and no
 * CSS transition fighting a per-frame transform.
 *
 * The one invariant to preserve: animation time is an INTEGRATED phase
 * (`iTime`), never wall-clock multiplied by a live speed. See the RAF loop.
 */
import './Orb.css';

import { Mesh, Program, Renderer, Triangle, Vec3 } from 'ogl';
import { useEffect, useRef } from 'react';

import type { VoiceOrbState } from '@/shared/machines/voice-session.machine';

type OrbProps = {
  state: VoiceOrbState;
  /** Tool-use overlay: prismatic hue cycling + extra turbulence on top of any state. */
  toolActive?: boolean;
  /** Live audio level 0..1, read every frame (a holder, not state). */
  levelSource?: { current: number };
};

type OrbParams = {
  scale: number;
  noiseAmplitude: number;
  noiseScale: number;
  innerRadius: number;
  hoverIntensity: number;
  animationSpeed: number;
  active: boolean;
};

/**
 * Ceiling on the composed scale, and the reason it exists: the shader maps
 * the canvas to uv radius 1 at scale 1 (`uv /= orbScale`) and the blob's
 * outer envelope ends at `len == 1`, so 1.0 is exactly inscribed. Above it
 * the blob is drawn outside the canvas and cut off flat at the edge
 * midpoints — the orb visibly squares off. Every state's range lives under
 * this, and the clamp at the end of `orbParamsFor` is the guarantee.
 */
export const MAX_ORB_SCALE = 1;

/**
 * The size every attending state renders at. Size does NOT encode which
 * state we're in — motion does (tempo, turbulence, the tool overlay's hue).
 * State-driven size was the whole reason changes read as drastic: at this
 * canvas the old idle→speaking step moved the diameter by ~110px before the
 * voice had said anything.
 */
export const NEUTRAL_ORB_SCALE = 0.82;
/** Idle sits under neutral — asleep, and always the smallest thing shown. */
const IDLE_SCALE = 0.66;
/**
 * Turn ownership, the one thing volume is allowed to say, in opposing
 * directions: the orb draws in to listen and swells to speak. Speaking's
 * ceiling is exactly the inscribed radius, so a shout fills the canvas and
 * never crosses it.
 */
const LISTEN_SHRINK = 0.12;
const SPEAK_GROW = MAX_ORB_SCALE - NEUTRAL_ORB_SCALE;

/** Per-state targets; `t` in ms, `level` 0..1. Exported for tests. */
export function orbParamsFor(state: VoiceOrbState, toolActive: boolean, t: number, level: number): OrbParams {
  let p: OrbParams;
  switch (state) {
    case 'listening':
      // Level drives SIZE only. Tempo and turbulence stay fixed: a speed that
      // tracks the mic reads as jitter rather than attention (and used to
      // teleport the phase — see the RAF loop), and the hover ripple added
      // motion that carried no signal at all.
      p = {
        scale: NEUTRAL_ORB_SCALE - Math.min(level, 1) * LISTEN_SHRINK,
        noiseAmplitude: 0.45,
        noiseScale: 0.35,
        innerRadius: 0.2,
        hoverIntensity: 0,
        animationSpeed: 0.9,
        active: true,
      };
      break;
    case 'thinking':
      // Deliberately no size treatment of its own: the doubled tempo and
      // the heavier turbulence below already read as "working".
      p = {
        scale: NEUTRAL_ORB_SCALE,
        noiseAmplitude: 0.7,
        noiseScale: 0.5,
        innerRadius: 0.15,
        hoverIntensity: 0.1,
        animationSpeed: 2.0,
        active: true,
      };
      break;
    case 'speaking':
      p = {
        scale: NEUTRAL_ORB_SCALE + Math.min(level, 1) * SPEAK_GROW,
        noiseAmplitude: Math.min(0.75 + level * 0.25, 0.95),
        noiseScale: 0.4,
        innerRadius: 0.18,
        hoverIntensity: 0.12,
        animationSpeed: 1.3,
        active: true,
      };
      break;
    default: {
      // idle — sleeping but aware: slow breathing pulse.
      const breath = Math.sin(t / 1500) * 0.02 + 1.0;
      p = {
        scale: IDLE_SCALE * breath,
        noiseAmplitude: 0.5 * breath,
        noiseScale: 0.35,
        innerRadius: 0.2,
        hoverIntensity: 0,
        animationSpeed: 0.8,
        active: false,
      };
    }
  }

  if (toolActive) {
    const mainPulse = Math.sin(t / 450) * 0.07 + 1.0;
    const corePulse = Math.sin(t / 700) * 0.04 + 0.14;
    const turbulencePulse = Math.sin(t / 300) * 0.15 + 0.85;
    p = {
      // Cap the base before pulsing so the swing has somewhere to go — at
      // full scale the pulse would just saturate against the ceiling and
      // the orb would sit still exactly when a tool is running.
      scale: Math.min(p.scale, MAX_ORB_SCALE / 1.07) * mainPulse,
      noiseAmplitude: p.noiseAmplitude * turbulencePulse * 1.3,
      noiseScale: Math.max(p.noiseScale, 0.6),
      innerRadius: Math.min(p.innerRadius, corePulse),
      hoverIntensity: p.hoverIntensity + 0.15,
      animationSpeed: p.animationSpeed * 3.0,
      active: true,
    };
  }
  // Belt and braces: no state may exceed the inscribed radius, whatever the
  // level or the pulse phase happens to be.
  return p.scale > MAX_ORB_SCALE ? { ...p, scale: MAX_ORB_SCALE } : p;
}

/** Prismatic hue (degrees) while a tool runs; 0 otherwise. */
export function orbHueFor(toolActive: boolean, t: number): number {
  return toolActive ? (t / 8) % 360 : 0;
}

const vert = /* glsl */ `
  precision highp float;
  attribute vec2 position;
  attribute vec2 uv;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const frag = /* glsl */ `
  precision highp float;

  // Animation PHASE (seconds at the current speed), NOT wall time — see the
  // RAF loop. Nothing here may multiply it by a live speed uniform.
  uniform float iTime;
  uniform vec3 iResolution;
  uniform float hue;
  uniform float hover;
  uniform float rot;
  uniform float hoverIntensity;
  uniform float noiseScale;
  uniform float noiseAmplitude;
  uniform float innerRadius;
  uniform float orbScale;
  varying vec2 vUv;

  vec3 rgb2yiq(vec3 c) {
    float y = dot(c, vec3(0.299, 0.587, 0.114));
    float i = dot(c, vec3(0.596, -0.274, -0.322));
    float q = dot(c, vec3(0.211, -0.523, 0.312));
    return vec3(y, i, q);
  }

  vec3 yiq2rgb(vec3 c) {
    float r = c.x + 0.956 * c.y + 0.621 * c.z;
    float g = c.x - 0.272 * c.y - 0.647 * c.z;
    float b = c.x - 1.106 * c.y + 1.703 * c.z;
    return vec3(r, g, b);
  }

  vec3 adjustHue(vec3 color, float hueDeg) {
    float hueRad = hueDeg * 3.14159265 / 180.0;
    vec3 yiq = rgb2yiq(color);
    float cosA = cos(hueRad);
    float sinA = sin(hueRad);
    float i = yiq.y * cosA - yiq.z * sinA;
    float q = yiq.y * sinA + yiq.z * cosA;
    yiq.y = i;
    yiq.z = q;
    return yiq2rgb(yiq);
  }

  vec3 hash33(vec3 p3) {
    p3 = fract(p3 * vec3(0.1031, 0.11369, 0.13787));
    p3 += dot(p3, p3.yxz + 19.19);
    return -1.0 + 2.0 * fract(vec3(
      p3.x + p3.y,
      p3.x + p3.z,
      p3.y + p3.z
    ) * p3.zyx);
  }

  float snoise3(vec3 p) {
    const float K1 = 0.333333333;
    const float K2 = 0.166666667;
    vec3 i = floor(p + (p.x + p.y + p.z) * K1);
    vec3 d0 = p - (i - (i.x + i.y + i.z) * K2);
    vec3 e = step(vec3(0.0), d0 - d0.yzx);
    vec3 i1 = e * (1.0 - e.zxy);
    vec3 i2 = 1.0 - e.zxy * (1.0 - e);
    vec3 d1 = d0 - (i1 - K2);
    vec3 d2 = d0 - (i2 - K1);
    vec3 d3 = d0 - 0.5;
    vec4 h = max(0.6 - vec4(
      dot(d0, d0),
      dot(d1, d1),
      dot(d2, d2),
      dot(d3, d3)
    ), 0.0);
    vec4 n = h * h * h * h * vec4(
      dot(d0, hash33(i)),
      dot(d1, hash33(i + i1)),
      dot(d2, hash33(i + i2)),
      dot(d3, hash33(i + 1.0))
    );
    return dot(vec4(31.316), n);
  }

  vec4 extractAlpha(vec3 colorIn) {
    float a = max(max(colorIn.r, colorIn.g), colorIn.b);
    return vec4(colorIn.rgb / (a + 1e-5), a);
  }

  const vec3 baseColor1 = vec3(0.611765, 0.262745, 0.996078);
  const vec3 baseColor2 = vec3(0.298039, 0.760784, 0.913725);
  const vec3 baseColor3 = vec3(0.062745, 0.078431, 0.600000);

  float light1(float intensity, float attenuation, float dist) {
    return intensity / (1.0 + dist * attenuation);
  }
  float light2(float intensity, float attenuation, float dist) {
    return intensity / (1.0 + dist * dist * attenuation);
  }

  vec4 draw(vec2 uv) {
    vec3 color1 = adjustHue(baseColor1, hue);
    vec3 color2 = adjustHue(baseColor2, hue);
    vec3 color3 = adjustHue(baseColor3, hue);

    float ang = atan(uv.y, uv.x);
    float len = length(uv);
    float invLen = len > 0.0 ? 1.0 / len : 0.0;

    float n0 = snoise3(vec3(uv * noiseScale, iTime * 0.5)) * 0.5 + 0.5;
    float n0Scaled = n0 * noiseAmplitude;
    float r0 = mix(mix(innerRadius, 1.0, 0.4), mix(innerRadius, 1.0, 0.6), n0Scaled);
    float d0 = distance(uv, (r0 * invLen) * uv);
    float v0 = light1(1.0, 10.0, d0);
    v0 *= smoothstep(r0 * 1.05, r0, len);
    float cl = cos(ang + iTime * 2.0) * 0.5 + 0.5;

    float a = -iTime;
    vec2 pos = vec2(cos(a), sin(a)) * r0;
    float d = distance(uv, pos);
    float v1 = light2(1.5, 5.0, d);
    v1 *= light1(1.0, 50.0, d0);

    float v2 = smoothstep(1.0, mix(innerRadius, 1.0, n0 * 0.5), len);
    float v3 = smoothstep(innerRadius, mix(innerRadius, 1.0, 0.5), len);

    vec3 col = mix(color1, color2, cl);
    col = mix(color3, col, v0);
    col = (col + v1) * v2 * v3;
    col = clamp(col, 0.0, 1.0);

    return extractAlpha(col);
  }

  vec4 mainImage(vec2 fragCoord) {
    vec2 center = iResolution.xy * 0.5;
    float size = min(iResolution.x, iResolution.y);
    vec2 uv = (fragCoord - center) / size * 2.0;

    // Size lives in the shader (uv shrink = orb growth) — no CSS transform.
    uv /= max(orbScale, 0.05);

    float angle = rot;
    float s = sin(angle);
    float c = cos(angle);
    uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);

    uv.x += hover * hoverIntensity * 0.1 * sin(uv.y * 10.0 + iTime);
    uv.y += hover * hoverIntensity * 0.1 * sin(uv.x * 10.0 + iTime);

    return draw(uv);
  }

  void main() {
    vec2 fragCoord = vUv * iResolution.xy;
    vec4 col = mainImage(fragCoord);
    gl_FragColor = vec4(col.rgb * col.a, col.a);
  }
`;

const ROTATION_SPEED = 0.3;
/**
 * Approach rates, per SECOND (see `damp`). Size is split: it moves quickly
 * away from neutral so a voice onset registers, and returns slowly so the
 * orb settles rather than snapping back between syllables. With the ranges
 * this small, fast is calm — the drastic part was always the amplitude.
 */
const PARAM_RATE = 8;
const SCALE_RATE_AWAY = 12;
const SCALE_RATE_BACK = 6;
const HOVER_RATE = 6;
/** dt ceiling — a resumed background tab must not fast-forward the animation. */
const MAX_FRAME_S = 0.05;
/** Backing-store ceiling: past 2x there is nothing to see in a soft gradient. */
const MAX_PIXEL_RATIO = 2;

/** Frame-rate independent exponential approach; `rate` is per second. */
function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export default function Orb({ state, toolActive = false, levelSource }: OrbProps) {
  const ctnDom = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(state);
  const toolActiveRef = useRef(toolActive);
  stateRef.current = state;
  toolActiveRef.current = toolActive;
  const levelRef = useRef(levelSource);
  levelRef.current = levelSource;

  useEffect(() => {
    const container = ctnDom.current;
    if (!container) {
      return;
    }

    const renderer = new Renderer({ alpha: true, premultipliedAlpha: false });
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    container.appendChild(gl.canvas);

    const geometry = new Triangle(gl);
    const program = new Program(gl, {
      vertex: vert,
      fragment: frag,
      uniforms: {
        iTime: { value: 0 },
        iResolution: {
          value: new Vec3(gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height),
        },
        hue: { value: 0 },
        hover: { value: 0 },
        rot: { value: 0 },
        hoverIntensity: { value: 0 },
        noiseScale: { value: 0.35 },
        noiseAmplitude: { value: 0.5 },
        innerRadius: { value: 0.2 },
        orbScale: { value: 0.5 },
      },
    });

    const mesh = new Mesh(gl, { geometry, program });

    function resize() {
      if (!container) {
        return;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      const width = container.clientWidth;
      const height = container.clientHeight;
      renderer.setSize(width * dpr, height * dpr);
      gl.canvas.style.width = `${width}px`;
      gl.canvas.style.height = `${height}px`;
      program.uniforms.iResolution.value.set(gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height);
    }
    window.addEventListener('resize', resize);
    resize();

    // Capped: a 3x-DPR display would otherwise render 9x the pixels of a
    // full-screen-sized canvas for a shader that is all soft gradients.
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = motionQuery.matches;
    const onMotionPreference = () => {
      reducedMotion = motionQuery.matches;
    };
    motionQuery.addEventListener('change', onMotionPreference);

    let pointerHover = 0;
    let lastTime: number | null = null;
    let currentRot = 0;
    // Animation phase, integrated at the current speed. The shader must never
    // multiply absolute time by a live speed: a change of Δs would shift the
    // phase by iTime·Δs — seconds into a session that is a visible teleport of
    // the noise field and the orbiting light, and `listening` moves its speed
    // every frame with the mic level. Integrating means speed sets the rate
    // and nothing else, so the same wobble no longer registers as a jump.
    let phase = 0;
    let animSpeed = 0.8;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const size = Math.min(rect.width, rect.height);
      const uvX = ((e.clientX - rect.left - rect.width / 2) / size) * 2.0;
      const uvY = ((e.clientY - rect.top - rect.height / 2) / size) * 2.0;
      pointerHover = Math.sqrt(uvX * uvX + uvY * uvY) < 0.8 ? 1 : 0;
    };
    const handleMouseLeave = () => {
      pointerHover = 0;
    };
    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('mouseleave', handleMouseLeave);

    let rafId: number;
    const update = (t: number) => {
      rafId = requestAnimationFrame(update);
      // The first frame has no previous timestamp and a throttled tab resumes
      // with a huge one; both would jolt the phase and the rotation.
      const dt = lastTime === null ? 0 : Math.min((t - lastTime) * 0.001, MAX_FRAME_S);
      lastTime = t;

      // Reduced motion: hold the still frame for the state — no voice-driven
      // size, no breathing or pulse phase, no drift. State changes still
      // glide, because those are the user's own doing.
      const reduced = reducedMotion;
      const level = reduced ? 0 : (levelRef.current?.current ?? 0);
      const target = orbParamsFor(stateRef.current, toolActiveRef.current, reduced ? 0 : t, level);
      const u = program.uniforms;

      animSpeed = damp(animSpeed, target.animationSpeed, PARAM_RATE, dt);
      if (!reduced) {
        phase += dt * animSpeed;
      }
      u.iTime.value = phase;
      u.hue.value = reduced ? 0 : orbHueFor(toolActiveRef.current, t);
      // Away from neutral fast, back to it slow.
      const scaleRate =
        Math.abs(target.scale - NEUTRAL_ORB_SCALE) > Math.abs(u.orbScale.value - NEUTRAL_ORB_SCALE)
          ? SCALE_RATE_AWAY
          : SCALE_RATE_BACK;
      u.orbScale.value = damp(u.orbScale.value, target.scale, scaleRate, dt);
      u.noiseAmplitude.value = damp(u.noiseAmplitude.value, target.noiseAmplitude, PARAM_RATE, dt);
      u.noiseScale.value = damp(u.noiseScale.value, target.noiseScale, PARAM_RATE, dt);
      u.innerRadius.value = damp(u.innerRadius.value, target.innerRadius, PARAM_RATE, dt);
      u.hoverIntensity.value = damp(u.hoverIntensity.value, target.hoverIntensity, PARAM_RATE, dt);

      const effectiveHover = target.active ? 1 : pointerHover;
      u.hover.value = damp(u.hover.value, effectiveHover, HOVER_RATE, dt);
      if (effectiveHover > 0.5 && !reduced) {
        currentRot += dt * ROTATION_SPEED;
      }
      u.rot.value = currentRot;

      renderer.render({ scene: mesh });
    };
    rafId = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      motionQuery.removeEventListener('change', onMotionPreference);
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('mouseleave', handleMouseLeave);
      container.removeChild(gl.canvas);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, []);

  return <div ref={ctnDom} className="orb-container" />;
}
