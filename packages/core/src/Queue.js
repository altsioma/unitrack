import { EventEmitter } from './EventEmitter.js';

let nextQueueItemId = 1;

/** @extends {EventEmitter} */
export class QueueManager extends EventEmitter {
  /** @type {import('./types.js').QueueItem[]} */
  #items = [];
  /** @type {number} */
  #currentIndex = -1;

  /**
   * @param {import('./types.js').LogicalTrack | import('./types.js').LogicalTrack[]} trackOrTracks
   * @returns {import('./types.js').QueueItem[]}
   */
  add(trackOrTracks) {
    const tracks = Array.isArray(trackOrTracks) ? trackOrTracks : [trackOrTracks];
    const newItems = tracks.map((track) => ({ queueItemId: `qi_${nextQueueItemId++}`, track }));
    this.#items.push(...newItems);
    this.emit('changed');
    return newItems;
  }

  /**
   * @param {string} queueItemId
   * @returns {boolean}
   */
  remove(queueItemId) {
    const idx = this.#items.findIndex((i) => i.queueItemId === queueItemId);
    if (idx === -1) return false;
    this.#items.splice(idx, 1);
    if (this.#items.length === 0) {
      this.#currentIndex = -1;
    } else if (idx < this.#currentIndex) {
      this.#currentIndex -= 1;
    } else if (idx === this.#currentIndex && this.#currentIndex >= this.#items.length) {
      this.#currentIndex = this.#items.length - 1;
    }
    this.emit('changed');
    return true;
  }

  /**
   * @param {string} queueItemId
   * @param {number} newIndex
   * @returns {boolean}
   */
  reorder(queueItemId, newIndex) {
    const idx = this.#items.findIndex((i) => i.queueItemId === queueItemId);
    if (idx === -1) return false;
    const clampedIndex = Math.max(0, Math.min(newIndex, this.#items.length - 1));
    const currentItemId = this.#currentIndex >= 0 ? this.#items[this.#currentIndex].queueItemId : null;
    const [item] = this.#items.splice(idx, 1);
    this.#items.splice(clampedIndex, 0, item);
    this.#currentIndex = currentItemId
      ? this.#items.findIndex((i) => i.queueItemId === currentItemId)
      : -1;
    this.emit('changed');
    return true;
  }

  /** @returns {void} */
  clear() {
    this.#items = [];
    this.#currentIndex = -1;
    this.emit('changed');
  }

  /** @returns {import('./types.js').QueueItem[]} */
  getItems() {
    return [...this.#items];
  }

  /** @returns {import('./types.js').QueueItem | undefined} */
  getCurrentItem() {
    return this.#currentIndex >= 0 ? this.#items[this.#currentIndex] : undefined;
  }

  /** @returns {number} */
  getCurrentIndex() {
    return this.#currentIndex;
  }

  /** @returns {boolean} */
  moveNext() {
    if (this.#currentIndex + 1 >= this.#items.length) return false;
    this.#currentIndex += 1;
    this.emit('changed');
    return true;
  }

  /** @returns {boolean} */
  movePrevious() {
    if (this.#currentIndex <= 0) return false;
    this.#currentIndex -= 1;
    this.emit('changed');
    return true;
  }

  /**
   * @param {number} index
   * @returns {void}
   */
  setCurrentIndex(index) {
    if (index < -1 || index >= this.#items.length) {
      throw new RangeError(`Index out of bounds: ${index}`);
    }
    this.#currentIndex = index;
    this.emit('changed');
  }
}
