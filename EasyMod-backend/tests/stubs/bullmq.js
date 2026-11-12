'use strict';

const unmockedOperation = (type, name, operation) => () => {
    throw new Error(
        `Unmocked BullMQ ${type} "${name}" operation "${operation}" was called in the unit suite. `
        + 'Use an explicit per-test mock or the PostgreSQL/Redis integration suite.',
    );
};

class Queue {
    constructor(name, options = {}) {
        this.name = name;
        this.options = options;
    }

    on() { return this; }
    close() { return Promise.resolve(); }
    add(...args) { return unmockedOperation('Queue', this.name, 'add')(...args); }
    addBulk(...args) { return unmockedOperation('Queue', this.name, 'addBulk')(...args); }
    getJob(...args) { return unmockedOperation('Queue', this.name, 'getJob')(...args); }
    getJobs(...args) { return unmockedOperation('Queue', this.name, 'getJobs')(...args); }
    getJobCounts(...args) { return unmockedOperation('Queue', this.name, 'getJobCounts')(...args); }
    getWaitingCount(...args) { return unmockedOperation('Queue', this.name, 'getWaitingCount')(...args); }
    getActiveCount(...args) { return unmockedOperation('Queue', this.name, 'getActiveCount')(...args); }
    getFailedCount(...args) { return unmockedOperation('Queue', this.name, 'getFailedCount')(...args); }
    getDelayedCount(...args) { return unmockedOperation('Queue', this.name, 'getDelayedCount')(...args); }
}

class Worker {
    constructor(name) {
        this.name = name;
    }

    on() { return this; }
    close() { return Promise.resolve(); }
}

class QueueEvents extends Worker {}

class UnrecoverableError extends Error {}
class DelayedError extends Error {}

module.exports = {
    Queue,
    Worker,
    QueueEvents,
    UnrecoverableError,
    DelayedError,
};
