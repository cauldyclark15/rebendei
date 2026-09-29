/** Per-socket limits (in-flight frames count as pending). startServer options
 * override env; all values must be positive safe integers:
 * wsMaxPending / REBENDEI_WS_MAX_PENDING: 64 frames
 * wsMaxPendingBytes / REBENDEI_WS_MAX_PENDING_BYTES: 8 MiB (UTF-8 wire bytes)
 * wsMaxSubscriptions / REBENDEI_WS_MAX_SUBSCRIPTIONS: 1,000 subscriptions
 * wsMaxFrameSize / REBENDEI_WS_MAX_FRAME_SIZE: 1 MiB (Bun maxPayloadLength)
 * Queue/subscription overflow sends fatal then closes; Bun rejects oversized
 * individual frames before delivering them to the message handler.
 * @typedef {{wsMaxPending?:number,wsMaxPendingBytes?:number,wsMaxSubscriptions?:number,wsMaxFrameSize?:number}} WsOptions
 */
/** @param {WsOptions} [options] */
export function syncLimits(options = {}) {
  /** @param {keyof WsOptions} key @param {string} env @param {number} fallback */
  const limit = (key, env, fallback) => {
    const value = options[key] ?? (process.env[env] === undefined ? fallback : Number(process.env[env]));
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive safe integer`);
    return value;
  };
  return {
    pending: limit("wsMaxPending", "REBENDEI_WS_MAX_PENDING", 64),
    pendingBytes: limit("wsMaxPendingBytes", "REBENDEI_WS_MAX_PENDING_BYTES", 8 * 1024 * 1024),
    subscriptions: limit("wsMaxSubscriptions", "REBENDEI_WS_MAX_SUBSCRIPTIONS", 1000),
    frameSize: limit("wsMaxFrameSize", "REBENDEI_WS_MAX_FRAME_SIZE", 1024 * 1024),
  };
}
