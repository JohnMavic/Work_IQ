export const BRAIN_RUN_CLASS = Object.freeze({
  INTERACTIVE: 'interactive',
  BACKGROUND: 'background'
});

export const DEFAULT_GLOBAL_BRAIN_LIMIT = 2;
export const DEFAULT_BACKGROUND_BRAIN_LIMIT = 1;

function normalizeRunClass(value) {
  return value === BRAIN_RUN_CLASS.INTERACTIVE
    ? BRAIN_RUN_CLASS.INTERACTIVE
    : BRAIN_RUN_CLASS.BACKGROUND;
}

function safeNotify(callback, payload) {
  if (!callback) return;
  try { callback(payload); } catch {}
}

export class PriorityBrainScheduler {
  constructor({
    globalLimit = DEFAULT_GLOBAL_BRAIN_LIMIT,
    backgroundLimit = DEFAULT_BACKGROUND_BRAIN_LIMIT,
    now = () => Date.now()
  } = {}) {
    this.globalLimit = Math.max(1, Number(globalLimit) || DEFAULT_GLOBAL_BRAIN_LIMIT);
    this.backgroundLimit = Math.max(0, Number(backgroundLimit) || DEFAULT_BACKGROUND_BRAIN_LIMIT);
    this.now = now;
    this.active = new Map();
    this.queues = {
      [BRAIN_RUN_CLASS.INTERACTIVE]: [],
      [BRAIN_RUN_CLASS.BACKGROUND]: []
    };
    this.nextId = 1;
    this.draining = false;
  }

  activeCount(runClass = null) {
    if (!runClass) return this.active.size;
    const normalized = normalizeRunClass(runClass);
    let count = 0;
    for (const entry of this.active.values()) {
      if (entry.runClass === normalized) count++;
    }
    return count;
  }

  queuedCount(runClass = null) {
    if (!runClass) {
      return this.queues[BRAIN_RUN_CLASS.INTERACTIVE].length + this.queues[BRAIN_RUN_CLASS.BACKGROUND].length;
    }
    return this.queues[normalizeRunClass(runClass)].length;
  }

  snapshot() {
    return {
      globalLimit: this.globalLimit,
      backgroundLimit: this.backgroundLimit,
      active: {
        total: this.activeCount(),
        interactive: this.activeCount(BRAIN_RUN_CLASS.INTERACTIVE),
        background: this.activeCount(BRAIN_RUN_CLASS.BACKGROUND)
      },
      queued: {
        total: this.queuedCount(),
        interactive: this.queuedCount(BRAIN_RUN_CLASS.INTERACTIVE),
        background: this.queuedCount(BRAIN_RUN_CLASS.BACKGROUND)
      }
    };
  }

  queuedAhead(request) {
    const queue = this.queues[request.runClass] || [];
    const index = queue.indexOf(request);
    if (index < 0) return 0;
    if (request.runClass === BRAIN_RUN_CLASS.INTERACTIVE) return index;
    return this.queues[BRAIN_RUN_CLASS.INTERACTIVE].length + index;
  }

  canStart(runClass) {
    const normalized = normalizeRunClass(runClass);
    if (this.activeCount() >= this.globalLimit) return false;
    if (normalized === BRAIN_RUN_CLASS.INTERACTIVE) return true;
    if (this.activeCount(BRAIN_RUN_CLASS.BACKGROUND) >= this.backgroundLimit) return false;
    return this.queues[BRAIN_RUN_CLASS.INTERACTIVE].length === 0;
  }

  run(runClass, work, { onStateChange = null, label = null } = {}) {
    const normalized = normalizeRunClass(runClass);
    if (typeof work !== 'function') {
      throw new Error('PriorityBrainScheduler.run requires a work function');
    }

    return new Promise((resolve, reject) => {
      const request = {
        id: this.nextId++,
        runClass: normalized,
        label,
        work,
        resolve,
        reject,
        onStateChange,
        queuedAt: this.now(),
        startedAt: null
      };
      this.queues[normalized].push(request);
      this.notifyQueued();
      this.drain();
    });
  }

  notifyQueued() {
    for (const runClass of [BRAIN_RUN_CLASS.INTERACTIVE, BRAIN_RUN_CLASS.BACKGROUND]) {
      for (const request of this.queues[runClass]) {
        safeNotify(request.onStateChange, {
          state: 'queued',
          requestId: request.id,
          runClass: request.runClass,
          label: request.label,
          queuedAt: request.queuedAt,
          queuedAhead: this.queuedAhead(request),
          scheduler: this.snapshot()
        });
      }
    }
  }

  notifyRequest(request, state) {
    safeNotify(request.onStateChange, {
      state,
      requestId: request.id,
      runClass: request.runClass,
      label: request.label,
      queuedAt: request.queuedAt,
      startedAt: request.startedAt,
      queuedAhead: 0,
      scheduler: this.snapshot()
    });
  }

  drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.activeCount() < this.globalLimit) {
        let request = null;
        if (this.queues[BRAIN_RUN_CLASS.INTERACTIVE].length && this.canStart(BRAIN_RUN_CLASS.INTERACTIVE)) {
          request = this.queues[BRAIN_RUN_CLASS.INTERACTIVE].shift();
        } else if (this.queues[BRAIN_RUN_CLASS.BACKGROUND].length && this.canStart(BRAIN_RUN_CLASS.BACKGROUND)) {
          request = this.queues[BRAIN_RUN_CLASS.BACKGROUND].shift();
        }
        if (!request) break;
        this.start(request);
      }
    } finally {
      this.draining = false;
    }
  }

  start(request) {
    request.startedAt = this.now();
    this.active.set(request.id, request);
    this.notifyRequest(request, 'starting');
    this.notifyQueued();

    Promise.resolve()
      .then(() => request.work())
      .then(request.resolve, request.reject)
      .finally(() => {
        this.active.delete(request.id);
        this.notifyRequest(request, 'finished');
        this.notifyQueued();
        this.drain();
      });
  }
}

export const defaultBrainScheduler = new PriorityBrainScheduler();
