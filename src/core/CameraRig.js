import { PerspectiveCamera, Vector3, MathUtils, MOUSE, TOUCH } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { settings } from '../config/settings.js';
import { clamp, damp } from '../utils/math.js';
import { LAYER } from './Layers.js';

const _dir = new Vector3();
const _desiredTarget = new Vector3();
const _followPos = new Vector3();

/**
 * Third-person camera rig.
 *
 * Two modes:
 *  - orbit (casting): right-drag orbits the character, wheel zooms.
 *  - follow (walk): camera sits behind the character at a fixed offset,
 *    turning with the character's yaw. Right-drag adds an azimuth offset.
 *
 * Left mouse is always reserved for path drawing.
 */
export class CameraRig {
  constructor(domElement) {
    this.camera = new PerspectiveCamera(
      settings.camera.fov,
      window.innerWidth / window.innerHeight,
      0.1,
      400
    );
    this.camera.position.set(-6.5, 6.0, 9.5);
    this.camera.layers.enable(LAYER.VFX);

    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;
    this.controls.enableZoom = false; // the wheel drives `settings.camera.distance` instead
    this.controls.minPolarAngle = settings.camera.minPolar;
    this.controls.maxPolarAngle = settings.camera.maxPolar;
    this.controls.rotateSpeed = 0.65;

    // Free the left button for path drawing.
    this.controls.mouseButtons = { LEFT: null, MIDDLE: null, RIGHT: MOUSE.ROTATE };
    this.controls.touches = { ONE: null, TWO: TOUCH.DOLLY_ROTATE };

    this.anchor = new Vector3(0, 0, 0); // the character
    this.focus = new Vector3(0, 0, 0); // point of interest (ability head)
    this.focusWeight = 0;
    this.shakeOffset = new Vector3();
    this.shakeRoll = 0;

    this.controls.target.set(0, settings.camera.targetHeight, 0);
    this.controls.update();

    // Actual distance, eased toward `settings.camera.distance` so a wheel flick
    // glides instead of snapping.
    this.distance = settings.camera.distance;

    // Follow-mode state
    this.follow = false;
    this.followYaw = 0; // character yaw, set by App each frame
    this._followAzimuth = 0; // user right-drag offset
    this._followPolar = 0.35; // pitch offset from horizontal
    this._rightDragging = false;
    this._lastPointerX = 0;
    this._lastPointerY = 0;

    this.domElement = domElement;
    this._onWheel = this._onWheel.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    domElement.addEventListener('wheel', this._onWheel, { passive: false });
    domElement.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
  }

  /** Wheel zoom. Multiplicative, so each notch feels the same at any distance. */
  _onWheel(event) {
    event.preventDefault();

    const cam = settings.camera;
    // Firefox reports lines (deltaMode 1) and pages (2) rather than pixels.
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    const delta = (event.deltaY * scale) / 100;

    cam.distance = clamp(
      cam.distance * Math.exp(delta * 0.12 * cam.zoomSpeed),
      cam.minDistance,
      cam.maxDistance
    );
  }

  // Right-drag adjusts the follow azimuth / polar offset.
  _onPointerDown(event) {
    if (!this.follow || event.button !== 2) return;
    this._rightDragging = true;
    this._lastPointerX = event.clientX;
    this._lastPointerY = event.clientY;
  }

  _onPointerMove(event) {
    if (!this._rightDragging) return;
    const dx = event.clientX - this._lastPointerX;
    const dy = event.clientY - this._lastPointerY;
    this._lastPointerX = event.clientX;
    this._lastPointerY = event.clientY;
    this._followAzimuth -= dx * 0.005;
    this._followPolar = clamp(this._followPolar + dy * 0.003, 0.05, 1.2);
  }

  _onPointerUp() {
    this._rightDragging = false;
  }

  /** Point the rig should orbit around (character position). */
  setAnchor(x, y, z) {
    this.anchor.set(x, y, z);
  }

  /** Nudge the look-at point toward an ability. `weight` 0..1, decays on its own. */
  lookAt(point, weight = 1) {
    this.focus.copy(point);
    this.focusWeight = Math.max(this.focusWeight, weight);
  }

  /** Enable/disable follow-camera mode (walk mode). */
  setFollow(enabled) {
    this.follow = !!enabled;
    if (this.follow) {
      // Reset user offsets when entering follow
      this._followAzimuth = 0;
      this._followPolar = 0.35;
    }
  }

  update(dt) {
    const cam = settings.camera;

    if (this.camera.fov !== cam.fov) {
      this.camera.fov = cam.fov;
      this.camera.updateProjectionMatrix();
    }
    this.controls.minPolarAngle = cam.minPolar;
    this.controls.maxPolarAngle = cam.maxPolar;

    // Blend the orbit target between the character and any active ability.
    const blend = MathUtils.clamp(this.focusWeight * cam.autoFrame, 0, 0.85);
    _desiredTarget.copy(this.anchor);
    _desiredTarget.y += cam.targetHeight;
    _desiredTarget.lerp(this.focus, blend);

    if (this.follow) {
      this._updateFollow(dt, _desiredTarget);
    } else {
      this._updateOrbit(dt, _desiredTarget);
    }

    this.focusWeight = damp(this.focusWeight, 0, 0.08, dt);

    // Camera shake is additive and applied after the controls have settled.
    if (this.shakeOffset.lengthSq() > 0) {
      this.camera.position.add(this.shakeOffset);
      this.camera.rotateZ(this.shakeRoll);
    }
  }

  _updateOrbit(dt, desiredTarget) {
    const cam = settings.camera;
    this.controls.target.set(
      damp(this.controls.target.x, desiredTarget.x, cam.damping, dt),
      damp(this.controls.target.y, desiredTarget.y, cam.damping, dt),
      damp(this.controls.target.z, desiredTarget.z, cam.damping, dt)
    );
    this.controls.update();

    // Enforce the orbit distance (zoom and the editor slider both land here).
    this.distance = damp(this.distance, cam.distance, cam.zoomDamping, dt);
    _dir.copy(this.camera.position).sub(this.controls.target);
    const len = _dir.length() || 1;
    _dir.multiplyScalar(1 / len);
    this.camera.position.copy(this.controls.target).addScaledVector(_dir, this.distance);
  }

  _updateFollow(dt, desiredTarget) {
    const cam = settings.camera;
    const fcfg = settings.camera.follow;

    // Ease the look-at target toward the character
    this.controls.target.set(
      damp(this.controls.target.x, desiredTarget.x, cam.damping, dt),
      damp(this.controls.target.y, desiredTarget.y, cam.damping, dt),
      damp(this.controls.target.z, desiredTarget.z, cam.damping, dt)
    );

    // Camera sits behind the character: opposite of (yaw + azimuth offset)
    const yaw = this.followYaw + this._followAzimuth + Math.PI;
    const polar = this._followPolar;
    const dist = damp(this.distance, fcfg.distance, cam.zoomDamping, dt);
    this.distance = dist;

    const h = dist * Math.cos(polar);
    const v = dist * Math.sin(polar);
    _followPos.set(
      this.controls.target.x + Math.sin(yaw) * h,
      this.controls.target.y + v,
      this.controls.target.z + Math.cos(yaw) * h
    );
    this.camera.position.copy(_followPos);
    this.camera.lookAt(this.controls.target);
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.domElement.removeEventListener('wheel', this._onWheel);
    this.domElement.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    this.controls.dispose();
  }
}
