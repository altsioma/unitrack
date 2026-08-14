import { EventEmitter } from './EventEmitter.js';
import { QueueManager } from './Queue.js';
import { PluginRegistry } from './PluginRegistry.js';

/** @extends {EventEmitter} */
export class CorePlayer extends EventEmitter {
  /** @type {PluginRegistry} */
  #registry = new PluginRegistry();
  /** @type {QueueManager} */
  queue = new QueueManager();
  /** @type {import('./types.js').SourcePolicyRule[]} */
  #policy = [];
  /** @type {import('./types.js').PlayerStatus} */
  #status = 'idle';
  /** @type {number} */
  #position = 0;
  /** @type {number} */
  #duration = 0;

  constructor() {
    super();
    this.queue.on('changed', () => this.emit('queueChanged'));
  }

  /** @param {import('./types.js').SourceProvider} plugin @returns {void} */
  registerSourceProvider(plugin) {
    this.#registry.registerSourceProvider(plugin);
  }

  /** @param {import('./types.js').PlaybackEngine} plugin @returns {void} */
  registerPlaybackEngine(plugin) {
    this.#registry.registerPlaybackEngine(plugin);
  }

  /** @param {import('./types.js').MetadataProvider} plugin @returns {void} */
  registerMetadataProvider(plugin) {
    this.#registry.registerMetadataProvider(plugin);
  }

  /** @param {import('./types.js').PlaylistProvider} plugin @returns {void} */
  registerPlaylistProvider(plugin) {
    this.#registry.registerPlaylistProvider(plugin);
  }

  /** @param {import('./types.js').SourcePolicyRule[]} policyRules @returns {void} */
  setPolicy(policyRules) {
    this.#policy = policyRules;
  }

  /** @returns {import('./types.js').CoreState} */
  getState() {
    return {
      status: this.#status,
      currentQueueItem: this.queue.getCurrentItem(),
      position: this.#position,
      duration: this.#duration,
      queue: this.queue.getItems(),
      policy: this.#policy,
    };
  }

  /** @param {import('./types.js').CoreState} snapshot @returns {void} */
  restoreState(snapshot) {
    this.queue.clear();
    for (const item of snapshot.queue ?? []) {
      this.queue.add(item.track);
    }
    const currentQueueItem = snapshot.currentQueueItem;
    const originalIndex = currentQueueItem
      ? snapshot.queue.findIndex((i) => i.queueItemId === currentQueueItem.queueItemId)
      : -1;
    this.queue.setCurrentIndex(originalIndex);
    this.#policy = snapshot.policy ?? [];
    this.#status = 'idle';
    this.#position = snapshot.position ?? 0;
    this.#duration = snapshot.duration ?? 0;
  }
}
