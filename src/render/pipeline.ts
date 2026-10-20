/**
 * Pixel-art isometric pipeline (three 0.186): an orthographic camera at 30° elevation sitting
 * opposite screen-up (north-west of the focus at the home seat, turnable by quarter turns), the
 * scene rendered into a low-res HalfFloat target (~270 texels tall), then one fullscreen pass that
 * draws depth-edge outlines, converts linear to sRGB and upscales by an integer factor with a
 * sub-texel scroll offset. The camera snaps to the texel grid, so the static world never shimmers
 * while the view still scrolls smoothly.
 *
 * @module render/pipeline
 */
import {
  DepthTexture, HalfFloatType, Matrix4, NearestFilter, Object3D, OrthographicCamera, ShaderMaterial, Vector2, Vector3,
  WebGLRenderTarget, type DirectionalLight, type Scene, type WebGLRenderer
} from "three"
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js"

import { screenAxes } from "../sim/view.ts"

/** 30° elevation: world ground axes project to exact 2:1 pixel lines. */
const ELEVATION = Math.PI / 6
const MARGIN = 1 // extra low-res texels per side, consumed by the sub-texel offset
const DISTANCE = 500 // metres from focus to camera along the view axis
const NEAR = 1
const FAR = 1000

/** Radians of view yaw per quarter turn of the sim's `View` (a turn to the left is counter-clockwise). */
export const QUARTER = Math.PI / 2

const aim = new Matrix4(), origin = new Vector3()
/**
 * Writes the camera's right/up/back axes (three space, the columns of its rotation) for a view
 * turned `yaw` rad to the left of the home seat into the given vectors, and returns the rotation.
 * At the home seat the camera looks along screen-up on the ground (sim y = north maps to three −z),
 * from the opposite side, 30° up. A turn to the left (counter-clockwise from above in the sim)
 * is a rotation about three's +y.
 */
const aimAt = (yaw: number, right: Vector3, up: Vector3, back: Vector3): Matrix4 => {
  const home = screenAxes(0).up, c = Math.cos(ELEVATION)
  const eye = new Vector3(-home.x * c, Math.sin(ELEVATION), home.y * c).applyAxisAngle(Object3D.DEFAULT_UP, yaw)
  return aim.lookAt(eye, origin, Object3D.DEFAULT_UP).extractBasis(right, up, back)
}

/** The camera's right/up/back axes (three space) for a view turned `yaw` rad to the left of the home seat. */
export const viewAxes = (yaw: number): { readonly right: Vector3; readonly up: Vector3; readonly back: Vector3 } => {
  const right = new Vector3(), up = new Vector3(), back = new Vector3()
  aimAt(yaw, right, up, back)
  return { right, up, back }
}

const FRAGMENT = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 uRtSize;
  uniform float uScale;
  uniform vec2 uOffset;
  uniform float uDepthRange;
  uniform float uOutlineMetres;
  uniform float uOutlineDarken;

  // Orthographic camera: the depth buffer is linear in [near, far].
  float depthAt(vec2 t) { return texture2D(tDepth, (t + 0.5) / uRtSize).r * uDepthRange; }

  void main() {
    vec2 t = floor(gl_FragCoord.xy / uScale + uOffset);
    vec4 c = texture2D(tColor, (t + 0.5) / uRtSize);
    float d = depthAt(t);
    float deeper = max(
      max(depthAt(t + vec2(1.0, 0.0)), depthAt(t - vec2(1.0, 0.0))),
      max(depthAt(t + vec2(0.0, 1.0)), depthAt(t - vec2(0.0, 1.0)))) - d;
    if (deeper > uOutlineMetres) c.rgb *= uOutlineDarken;
    gl_FragColor = linearToOutputTexel(c);
  }`

/** The widest zoom `zoomFor` picks, texels per metre: the most ground the view ever shows. */
export const WIDEST_ZOOM = 5

/**
 * Texels per metre: 8 on foot, 6 in a car, 5 above 16 m/s; back to 6 only below 13 m/s, so town
 * speeds around the threshold never flip the zoom. `last` is the previous result.
 */
export const zoomFor = (speed: number | undefined, last: number): number => {
  if (speed === undefined) return 8
  const s = Math.abs(speed)
  return s > 16 || (s >= 13 && last === WIDEST_ZOOM) ? WIDEST_ZOOM : 6
}

/**
 * The view's yaw one frame of `dt` seconds on from `yaw`, swinging toward `target`: it eases out,
 * covering 1 − e^(−12·dt) of the way, but never slower than 1 rad/s, so a quarter turn lands in
 * about a third of a second and stops dead instead of creeping (any sub-texel creep shimmers).
 */
export const turnToward = (yaw: number, target: number, dt: number): number => {
  const rest = Math.abs(target - yaw), step = Math.max(rest * (1 - Math.exp(-12 * dt)), dt)
  return step >= rest ? target : yaw + Math.sign(target - yaw) * step
}

/** The low-res render target, the camera that fills it and the blit to the canvas. */
export class PixelView {
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, NEAR, FAR)
  /** World point the view is centred on; host code moves it. */
  readonly focus = new Vector3()
  /** Radians the view is turned to the left of its home seat; host code turns it. */
  yaw = 0
  /** Low-res texels per world metre (zoom). */
  texelsPerMetre = 8
  /** Device pixels per low-res texel (integer, from `resize`). */
  scale = 1
  /** Low-res texels on screen, margin excluded. */
  readonly view = new Vector2(1, 1)

  private readonly renderer: WebGLRenderer
  private readonly targetHeight: number
  private readonly target: WebGLRenderTarget
  private readonly blit: FullScreenQuad
  private readonly material: ShaderMaterial
  private readonly right = new Vector3()
  private readonly up = new Vector3()
  private readonly back = new Vector3()
  /** The yaw the camera and its axes were last aimed at. */
  private aimed = Number.NaN
  private readonly size = new Vector2()

  constructor(renderer: WebGLRenderer, targetHeight = 270) {
    this.renderer = renderer
    this.targetHeight = targetHeight
    this.target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter, depthTexture: new DepthTexture(1, 1)
    })
    this.material = new ShaderMaterial({
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        uRtSize: { value: new Vector2(1, 1) },
        uScale: { value: 1 },
        uOffset: { value: new Vector2(MARGIN, MARGIN) },
        uDepthRange: { value: FAR - NEAR },
        uOutlineMetres: { value: 1 },
        uOutlineDarken: { value: 0.45 }
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: FRAGMENT
    })
    this.blit = new FullScreenQuad(this.material)
  }

  /** Fits the canvas to the CSS size and picks the integer upscale for ~`targetHeight` texels. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(cssWidth, cssHeight)
    const device = this.renderer.getDrawingBufferSize(this.size)
    this.scale = Math.max(1, Math.round(device.y / this.targetHeight))
    this.view.set(Math.ceil(device.x / this.scale), Math.ceil(device.y / this.scale))
    this.target.setSize(this.view.x + 2 * MARGIN, this.view.y + 2 * MARGIN)
    this.material.uniforms["uRtSize"]!.value.set(this.target.width, this.target.height)
    this.material.uniforms["uScale"]!.value = this.scale
  }

  /** Visible ground extent in metres (width, depth along screen-up). */
  get ground(): { readonly width: number; readonly depth: number } {
    return { width: this.view.x / this.texelsPerMetre, depth: this.view.y / this.texelsPerMetre / Math.sin(ELEVATION) }
  }

  /** Renders one frame: camera turned to `yaw` and snapped to the texel grid, remainder handed to the blit. */
  render(scene: Scene): void {
    const texel = 1 / this.texelsPerMetre
    const cam = this.camera
    if (this.yaw !== this.aimed) {
      cam.quaternion.setFromRotationMatrix(aimAt(this.yaw, this.right, this.up, this.back))
      this.aimed = this.yaw
    }
    cam.left = (-this.target.width * texel) / 2
    cam.right = (this.target.width * texel) / 2
    cam.top = (this.target.height * texel) / 2
    cam.bottom = (-this.target.height * texel) / 2
    cam.updateProjectionMatrix()
    const fx = this.focus.dot(this.right) / texel, fy = this.focus.dot(this.up) / texel
    const sx = Math.round(fx), sy = Math.round(fy)
    cam.position.copy(this.right).multiplyScalar(sx * texel)
      .addScaledVector(this.up, sy * texel)
      .addScaledVector(this.back, this.focus.dot(this.back) + DISTANCE)
    cam.updateMatrixWorld()
    this.material.uniforms["uOffset"]!.value.set(MARGIN + fx - sx, MARGIN + fy - sy)
    this.renderer.setRenderTarget(this.target)
    this.renderer.render(scene, cam)
    this.renderer.setRenderTarget(null)
    this.blit.render(this.renderer)
  }
}

const lightBasis = new Matrix4(), lr = new Vector3(), lu = new Vector3(), lb = new Vector3()
/**
 * Centres the sun's shadow box (half size `half` m) on `focus`, snapped to shadow-map texels in
 * light space so shadow edges do not crawl while the camera moves. `sun.target` must be in the scene.
 */
export const followSun = (sun: DirectionalLight, focus: Vector3, toSun: Vector3, half: number): void => {
  const shadow = sun.shadow.camera
  shadow.left = -half
  shadow.right = half
  shadow.top = half
  shadow.bottom = -half
  shadow.updateProjectionMatrix()
  const texel = (2 * half) / sun.shadow.mapSize.x
  lightBasis.lookAt(toSun, origin, Object3D.DEFAULT_UP).extractBasis(lr, lu, lb)
  const x = Math.round(focus.dot(lr) / texel) * texel, y = Math.round(focus.dot(lu) / texel) * texel
  sun.target.position.copy(lr).multiplyScalar(x).addScaledVector(lu, y).addScaledVector(lb, focus.dot(lb))
  sun.position.copy(sun.target.position).addScaledVector(toSun, 400)
}
