/**
 * A minimal, dependency-free publish/subscribe primitive.
 * Deliberately not Node's `events.EventEmitter` so Core stays
 * runnable in environments without Node built-ins (e.g. a Tauri webview).
 */
export class EventEmitter {
  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();

  /**
   * @param {string} event
   * @param {Function} handler
   * @returns {void}
   */
  on(event, handler) {
    let listeners = this.#listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(handler);
  }

  /**
   * @param {string} event
   * @param {Function} handler
   * @returns {void}
   */
  off(event, handler) {
    this.#listeners.get(event)?.delete(handler);
  }

  /**
   * @param {string} event
   * @param {*} [payload]
   * @returns {void}
   */
  emit(event, payload) {
    for (const handler of this.#listeners.get(event) ?? []) {
      handler(payload);
    }
  }
}
