import { Fault, need } from "./errors.mjs";
export class Budget {
  constructor(store, id, limits, signal) {
    this.store = store;
    this.id = id;
    this.limits = limits;
    this.signal = signal;
    this.started = Date.now();
    this.requests = 0;
    this.candidates = 0;
    this.reservedCandidates = new Set();
    this.asr = 0;
  }
  check() {
    if (this.deadline)
      need(this.deadline.now() < this.deadline.at, "DAILY_WINDOW_CLOSED");
    if (this.signal?.aborted || this.store.getControl("cancel:" + this.id))
      throw new Fault("CANCELLED");
    need(
      this.limits.wallMs == null ||
        Date.now() - this.started < this.limits.wallMs,
      "WALL_BUDGET",
    );
    need(!this.store.getControl("pause"), "PERSISTENT_PAUSE");
  }
  spend(kind, n = 1) {
    this.check();
    const fields = {
      requests: "requests",
      candidates: "candidates",
      asr: "asrSeconds",
    };
    need(n >= 0 && Number.isFinite(n), "INVALID_BUDGET");
    need(
      this[kind] + n <= this.limits[fields[kind]],
      kind.toUpperCase() + "_BUDGET",
    );
    this[kind] += n;
    this.store.usage(this.id, this.requests, this.candidates, this.asr);
  }
  remaining() {
    this.check();
    return Math.max(
      1,
      Math.min(
        (this.limits.wallMs ?? Infinity) - (Date.now() - this.started),
        this.deadline ? this.deadline.at - this.deadline.now() : Infinity,
      ),
    );
  }
}
