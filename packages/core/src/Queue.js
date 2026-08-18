import { EventEmitter } from './EventEmitter.js';

let nextQueueItemId = 1;

/** @extends {EventEmitter} */
export class QueueManager extends EventEmitter {
  /** @type {import('./types.js').QueueItem[]} */
  #items = [];
  /** @type {number} */
  #currentIndex = -1;
  /** @type {boolean} */
  #shuffle = false;
  /** @type {import('./types.js').RepeatMode} */
  #repeatMode = 'off';
  /** @type {number[]} */
  #shuffleHistory = [];
  /** @type {number} */
  #shuffleHistoryPos = -1;

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
    this.#resetShuffleHistory();
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
    this.#resetShuffleHistory();
    this.emit('changed');
    return true;
  }

  /** @returns {void} */
  clear() {
    this.#items = [];
    this.#currentIndex = -1;
    this.#resetShuffleHistory();
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
    if (this.#shuffle) return this.#moveNextShuffled();
    if (this.#currentIndex + 1 >= this.#items.length) {
      if (this.#repeatMode === 'all' && this.#items.length > 0) return this.#moveTo(0);
      return false;
    }
    return this.#moveTo(this.#currentIndex + 1);
  }

  /** @returns {boolean} */
  movePrevious() {
    if (this.#shuffle) return this.#movePreviousShuffled();
    if (this.#currentIndex <= 0) return false;
    return this.#moveTo(this.#currentIndex - 1);
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
    this.#resetShuffleHistory();
    this.emit('changed');
  }

  /** @returns {boolean} */
  isShuffleEnabled() {
    return this.#shuffle;
  }

  /**
   * @param {boolean} enabled
   * @returns {void}
   */
  setShuffle(enabled) {
    if (enabled === this.#shuffle) return;
    this.#shuffle = enabled;
    if (enabled) {
      this.#resetShuffleHistory();
    }
    this.emit('changed');
  }

  /** @returns {import('./types.js').RepeatMode} */
  getRepeatMode() {
    return this.#repeatMode;
  }

  /**
   * @param {import('./types.js').RepeatMode} mode
   * @returns {void}
   */
  setRepeatMode(mode) {
    if (mode === this.#repeatMode) return;
    this.#repeatMode = mode;
    this.emit('changed');
  }

  /**
   * Replaces shuffle playback history wholesale and points the pointer at
   * its last entry. The one place that actually assigns `#shuffleHistory`
   * — both `#resetShuffleHistory()` and the mid-cycle restart branch of
   * `#pickNextShuffled()` seed it through here rather than duplicating the
   * "assign array, then set pos = length - 1" shape.
   * @param {number[]} history
   * @returns {void}
   */
  #setShuffleHistory(history) {
    this.#shuffleHistory = history;
    this.#shuffleHistoryPos = history.length - 1;
  }

  /**
   * Reseeds shuffle playback history to just the current item (or empty, if
   * none) — the same starting point as freshly turning shuffle on. Called
   * whenever the queue's shape or position changes in a way that would
   * otherwise leave stale/incorrect canonical indices in the history.
   * @returns {void}
   */
  #resetShuffleHistory() {
    this.#setShuffleHistory(this.#currentIndex === -1 ? [] : [this.#currentIndex]);
  }

  /** @returns {boolean} */
  #moveNextShuffled() {
    if (this.#shuffleHistoryPos + 1 < this.#shuffleHistory.length) {
      this.#shuffleHistoryPos += 1;
      return this.#moveTo(this.#shuffleHistory[this.#shuffleHistoryPos]);
    }
    const pick = this.#pickNextShuffled();
    if (pick === undefined) return false;
    this.#shuffleHistory.push(pick);
    this.#shuffleHistoryPos = this.#shuffleHistory.length - 1;
    return this.#moveTo(pick);
  }

  /** @returns {boolean} */
  #movePreviousShuffled() {
    if (this.#shuffleHistoryPos <= 0) return false;
    this.#shuffleHistoryPos -= 1;
    return this.#moveTo(this.#shuffleHistory[this.#shuffleHistoryPos]);
  }

  /**
   * Jumps `#currentIndex` straight to `idx`, emits `changed`, and always
   * reports success — the one place `moveNext()`/`movePrevious()` and
   * their shuffled counterparts actually commit to a new position, so
   * they don't each repeat "assign, emit, return true".
   * @param {number} idx
   * @returns {true}
   */
  #moveTo(idx) {
    this.#currentIndex = idx;
    this.emit('changed');
    return true;
  }

  /**
   * Picks the next canonical index to visit while shuffled, or `undefined`
   * if there's nothing left to play. Draws uniformly from indices not yet
   * in the current shuffle history; once every index has been visited,
   * either stops (repeat !== 'all') or starts a fresh cycle (repeat ===
   * 'all'), excluding the just-played index from the new cycle's first
   * pick unless it's the only item in the queue.
   * @returns {number | undefined}
   */
  #pickNextShuffled() {
    const all = this.#items.map((_, idx) => idx);
    if (all.length === 0) return undefined;
    const played = new Set(this.#shuffleHistory);
    let remaining = all.filter((idx) => !played.has(idx));
    if (remaining.length > 0) {
      return remaining[Math.floor(Math.random() * remaining.length)];
    }
    if (this.#repeatMode !== 'all') return undefined;
    const justPlayed = this.#currentIndex;
    const excludeJustPlayed = all.length > 1 && justPlayed !== -1;
    this.#setShuffleHistory(excludeJustPlayed ? [justPlayed] : []);
    remaining = excludeJustPlayed ? all.filter((idx) => idx !== justPlayed) : all;
    return remaining[Math.floor(Math.random() * remaining.length)];
  }
}
