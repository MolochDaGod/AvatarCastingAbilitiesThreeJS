import { MathUtils, Vector3 } from 'three';
import { settings } from '../config/settings.js';
import { clamp, damp } from '../utils/math.js';

const _move = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _camFwd = new Vector3();
const _camRight = new Vector3();

const TAU = Math.PI * 2;
const wrapAngle = (a) => MathUtils.euclideanModulo(a + Math.PI, TAU) - Math.PI;

/**
 * WASD third-person movement for the character in walk mode.
 *
 * The character root is driven directly (position + yaw). The camera is read
 * each frame so "forward" always means "away from the camera" — the classic
 * third-person contract. No physics: just velocity damping + turn damping.
 *
 * It does NOT own the mixer or the pose layer; CharacterController keeps those.
 */
export class ThirdPersonController {
  constructor(character, camera) {
    this.character = character;
    this.camera = camera;
    this.active = false;

    this._yaw = 0;
    this._speed = 0;
    this._targetYaw = 0;
    this._moving = false;
  }

  /** Read the camera's horizontal forward/right into scratch vectors. */
  _readCamera() {
    this.camera.getWorldDirection(_camFwd);
    _camFwd.y = 0;
    if (_camFwd.lengthSq() < 1e-6) _camFwd.set(0, 0, 1);
    _camFwd.normalize();
    _camRight.set(_camFwd.z, 0, -_camFwd.x); // right = forward rotated -90° about Y
  }

  update(dt, keys) {
    if (!this.active) return;

    const cfg = settings.walk.move;
    this._readCamera();

    _move.set(0, 0, 0);
    if (keys.has('KeyW') || keys.has('ArrowUp')) _move.add(_camFwd);
    if (keys.has('KeyS') || keys.has('ArrowDown')) _move.sub(_camFwd);
    if (keys.has('KeyD') || keys.has('ArrowRight')) _move.add(_camRight);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) _move.sub(_camRight);

    const moving = _move.lengthSq() > 1e-6;
    this._moving = moving;

    if (moving) {
      _move.normalize();
      const targetYaw = Math.atan2(_move.x, _move.z);
      const delta = wrapAngle(targetYaw - this._targetYaw);
      this._targetYaw += delta;

      // Accelerate toward full speed
      this._speed = damp(this._speed, cfg.speed, 0.002, dt);
    } else {
      // Decelerate to stop
      this._speed = damp(this._speed, 0, 0.0005, dt);
    }

    // Smoothly rotate the body toward the target yaw
    const turnRate = clamp(cfg.turnDamping, 1e-4, 1);
    this._yaw += wrapAngle(this._targetYaw - this._yaw) * (1 - Math.pow(turnRate, dt));

    // Apply movement
    if (this._speed > 1e-4) {
      const pos = this.character.position;
      pos.x += Math.sin(this._yaw) * this._speed * dt;
      pos.z += Math.cos(this._yaw) * this._speed * dt;
    }

    this.character.setFacing(this._yaw);

    // Keep feet planted on the ground
    this.character.root.position.y = 0;
    this.character.setLean(0);
  }

  get isMoving() {
    return this._moving;
  }

  /** Current facing yaw, radians. */
  get yaw() {
    return this._yaw;
  }

  /** Snap the controller's yaw to the character's current facing. */
  sync() {
    this._yaw = this.character.facing;
    this._targetYaw = this._yaw;
    this._speed = 0;
  }
}
