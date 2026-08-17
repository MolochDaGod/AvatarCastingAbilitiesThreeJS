import { MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { settings } from '../config/settings.js';
import { clamp } from '../utils/math.js';

const _move = new Vector3();
const _camFwd = new Vector3();
const _camRight = new Vector3();
const _targetMat = new Matrix4();
const _targetQuat = new Quaternion();

const TAU = Math.PI * 2;
const wrapAngle = (a) => MathUtils.euclideanModulo(a + Math.PI, TAU) - Math.PI;

/**
 * WASD third-person movement for the character in walk mode.
 *
 * Follows the grudgecontrol pattern: proper acceleration / deceleration toward
 * a target velocity, quaternion slerp for smooth facing, and a simple jump arc
 * with gravity. The camera is read each frame so "forward" always means "away
 * from the camera" — the classic third-person contract.
 *
 * It does NOT own the mixer or the pose layer; CharacterController keeps those.
 */
export class ThirdPersonController {
  constructor(character, camera) {
    this.character = character;
    this.camera = camera;
    this.active = false;

    this._velocity = new Vector3();
    this._speed = 0;
    this._moving = false;
    this._onGround = true;
    this._jumpCount = 0;

    this._curQuat = new Quaternion();
    this._curEulerY = 0;
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

    const hasInput = _move.lengthSq() > 1e-6;
    this._moving = hasInput;

    if (hasInput) _move.normalize();

    // --- Acceleration / deceleration toward target velocity ---
    const targetSpeed = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? cfg.speed * 2 : cfg.speed;
    const targetX = hasInput ? _move.x * targetSpeed : 0;
    const targetZ = hasInput ? _move.z * targetSpeed : 0;

    const accel = (cfg.acceleration ?? 12) * dt;
    const decel = (cfg.deceleration ?? 10) * dt;

    const diffX = targetX - this._velocity.x;
    const diffZ = targetZ - this._velocity.z;
    const xzDiffLen = Math.hypot(diffX, diffZ);
    if (xzDiffLen > 0) {
      const step = Math.min(xzDiffLen, hasInput ? accel : decel);
      this._velocity.x += (diffX / xzDiffLen) * step;
      this._velocity.z += (diffZ / xzDiffLen) * step;
    }

    // --- Jump / gravity ---
    if (this._onGround) {
      this._velocity.y = 0;
    } else {
      this._velocity.y += (cfg.gravity ?? -25) * dt;
    }

    // Apply horizontal movement
    const pos = this.character.position;
    pos.x += this._velocity.x * dt;
    pos.z += this._velocity.z * dt;

    // Apply vertical movement (jump arc)
    pos.y += this._velocity.y * dt;
    if (pos.y <= 0) {
      pos.y = 0;
      this._velocity.y = 0;
      this._onGround = true;
      this._jumpCount = 0;
    }

    // --- Facing: quaternion slerp toward movement direction ---
    const xzSpeed = Math.hypot(this._velocity.x, this._velocity.z);
    if (xzSpeed > 0.1) {
      const moveAngle = Math.atan2(this._velocity.x, this._velocity.z);
      _targetMat.lookAt(
        _move.set(0, 0, 0), // origin (player position is irrelevant for rotation-only)
        _move.set(Math.sin(moveAngle), 0, Math.cos(moveAngle)), // look direction
        _move.set(0, 1, 0) // up
      );
      _targetQuat.setFromRotationMatrix(_targetMat);

      this.character.root.quaternion.slerp(
        _targetQuat,
        Math.min(1, (cfg.rotationSpeed ?? 10) * dt)
      );
    }

    this.character.setLean(0);

    // Track current yaw for camera follow
    this._curEulerY = this.character.facing;
  }

  /** Trigger a jump if grounded (or double-jump if allowed). */
  jump() {
    if (!this.active) return false;
    const cfg = settings.walk.move;
    const maxJumps = cfg.maxJumps ?? 1;
    if (this._jumpCount >= maxJumps) return false;
    this._velocity.y = cfg.jumpHeight ?? 8;
    this._onGround = false;
    this._jumpCount++;
    return true;
  }

  get isMoving() {
    return this._moving;
  }

  get isOnGround() {
    return this._onGround;
  }

  /** Current facing yaw, radians. */
  get yaw() {
    return this._curEulerY;
  }

  /** Snap the controller's state to the character's current placement. */
  sync() {
    this._curEulerY = this.character.facing;
    this._velocity.set(0, 0, 0);
    this._speed = 0;
    this._onGround = true;
    this._jumpCount = 0;
    this.character.root.position.y = 0;
  }
}
